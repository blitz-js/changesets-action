import { exec } from "@actions/exec";
import * as github from "@actions/github";
import fs from "fs-extra";
import { getPackages, Package } from "@manypkg/get-packages";
import path from "path";
import * as semver from "semver";
import { PreState } from "@changesets/types";
import {
  getChangelogEntry,
  execWithOutput,
  getChangedPackages,
  sortTheThings,
  getVersionsByDirectory,
  levelToString,
} from "./utils";
import * as gitUtils from "./gitUtils";
import readChangesetState from "./readChangesetState";
import resolveFrom from "resolve-from";

// GitHub Issues/PRs messages have a max size limit on the
// message body payload.
// `body is too long (maximum is 65536 characters)`.
// To avoid that, we ensure to cap the message to 60k chars.
const MAX_CHARACTERS_PER_MESSAGE = 60000;
let releasedPackages: Package[] = [];


const createRelease = async (
  octokit: ReturnType<typeof github.getOctokit>,
  // { pkg, tagName }: { pkg: Package; tagName: string }
  packages: Package[]
) => {
  try {

    let singleReleaseData: { tagName: string, body: string[], preRelease: boolean } = {
      tagName: ``,
      body: [],
      preRelease: false
    }

    let chnagelogContent: Record<'dep' | 'patch' | 'minor' | 'major', string[]> = {
      dep: [],
      patch: [],
      minor: [],
      major: [],
    }

    for (const pkg of packages) {
      let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");
      let changelog = await fs.readFile(changelogFileName, "utf8");
      let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);

      if (!changelogEntry) {
        // we can find a changelog but not the entry for this version
        // if this is true, something has probably gone wrong
        throw new Error(
          `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
        );
      }
      let content = changelogEntry.content.toString()
      let level = changelogEntry.highestLevel

      content = content.replace(/^### Patch Changes$/gm, '')
      content = content.replace(/^### Minor Changes$/gm, '')
      content = content.replace(/^### Major Changes$/gm, '')

      content = `
      ### ${pkg.packageJson.name}

      ${content}
      `

      chnagelogContent[levelToString(level)].push(content)

      singleReleaseData.tagName = `v${pkg.packageJson.version}`
      singleReleaseData.preRelease = pkg.packageJson.version.includes("-")
    }



    let finalChangelog: string[] = []

    if (chnagelogContent.major.length) {
      finalChangelog.push(
        `
        ## 🔥 Breaking Changes
        
        ${chnagelogContent.major.join('\n\n')}
        `
      )
    }

    if (chnagelogContent.minor.length) {
      finalChangelog.push(
        `
        ## 🚀 Features/Improvements
        
        ${chnagelogContent.minor.join('\n\n')}
        `
      )
    }

    if (chnagelogContent.patch.length) {
      finalChangelog.push(
        `
        ## 🐞 Patches
        
        ${chnagelogContent.patch.join('\n\n')}
        `
      )
    }

    if (finalChangelog.length) {
      await octokit.repos.createRelease({
        name: singleReleaseData.tagName,
        tag_name: singleReleaseData.tagName,
        body: finalChangelog.join('\n\n'),
        prerelease: singleReleaseData.preRelease,
        ...github.context.repo,
      });
    }
  } catch (err: any) {
    // if we can't find a changelog, the user has probably disabled changelogs
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
};

type PublishOptions = {
  script: string;
  githubToken: string;
  createGithubReleases: boolean;
  cwd?: string;
};

type PublishedPackage = { name: string; version: string };

type PublishResult =
  | {
    published: true;
    publishedPackages: PublishedPackage[];
  }
  | {
    published: false;
  };

export async function runPublish({
  script,
  githubToken,
  createGithubReleases,
  cwd = process.cwd(),
}: PublishOptions): Promise<PublishResult> {
  let octokit = github.getOctokit(githubToken);
  let [publishCommand, ...publishArgs] = script.split(/\s+/);

  let changesetPublishOutput = await execWithOutput(
    publishCommand,
    publishArgs,
    { cwd }
  );

  await gitUtils.pushTags();

  let { packages, tool } = await getPackages(cwd);


  if (tool !== "root") {
    /* 
      FOR **INSIDE** A MONOREPO
    */
    let newTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/;
    let packagesByName = new Map(packages.map((x) => [x.packageJson.name, x]));

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);
      if (match === null) {
        continue;
      }
      let pkgName = match[1];
      let pkg = packagesByName.get(pkgName);
      if (pkg === undefined) {
        throw new Error(
          `Package "${pkgName}" not found.` +
          "This is probably a bug in the action, please open an issue"
        );
      }
      releasedPackages.push(pkg);
    }

    if (createGithubReleases) {

      try {
        let singleReleaseData: { tagName: string, body: string[], preRelease: boolean } = {
          tagName: '',
          body: [],
          preRelease: false
        }

        let changelogContent: Record<'dep' | 'patch' | 'minor' | 'major', string[]> = {
          dep: [],
          patch: [],
          minor: [],
          major: [],
        }
    
        for (const pkg of releasedPackages) {
          let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");
          let changelog = await fs.readFile(changelogFileName, "utf8");
          let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
    
          if (!changelogEntry) {
            // we can find a changelog but not the entry for this version
            // if this is true, something has probably gone wrong
            throw new Error(
              `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
            );
          }
          let content = changelogEntry.content.toString()
          let level = changelogEntry.highestLevel
    
          content = content.replace(/^### Patch Changes$/gm, '')
          content = content.replace(/^### Minor Changes$/gm, '')
          content = content.replace(/^### Major Changes$/gm, '')
    
          content = `### ${pkg.packageJson.name}\n ${content}`

          console.log(pkg.packageJson.name, {content, level})
    
          changelogContent[levelToString(level)].push(content)
    
          singleReleaseData.tagName = `v${pkg.packageJson.version}`
          singleReleaseData.preRelease = pkg.packageJson.version.includes("-")
        }
    
        let finalChangelog: string[] = []
        if (changelogContent.major.length) {
          finalChangelog.push(
            `## 🔥 Breaking Changes\n ${changelogContent.major.join('\n\n')}`
          )
        }
    
        if (changelogContent.minor.length) {
          finalChangelog.push(
            `## 🚀 Features/Improvements\n ${changelogContent.minor.join('\n\n')}`
          )
        }
    
        if (changelogContent.patch.length) {
          finalChangelog.push(
            `## 🐞 Patches\n ${changelogContent.patch.join('\n\n')}`
          )
        }

        console.log({changelogContent, finalChangelog})
    
        if (finalChangelog.length) {
          await octokit.repos.createRelease({
            name: singleReleaseData.tagName,
            tag_name: singleReleaseData.tagName,
            body: finalChangelog.join('\n\n'),
            prerelease: singleReleaseData.preRelease,
            ...github.context.repo,
          });
        } else {
          throw new Error("Final Changelog empty")
        }
      } catch (err: any) {
        // if we can't find a changelog, the user has probably disabled changelogs
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

    }
  } else {

    /* 
      FOR **OUTSIDE** A MONOREPO
    */


    if (packages.length === 0) {
      throw new Error(
        `No package found.` +
        "This is probably a bug in the action, please open an issue"
      );
    }
    let pkg = packages[0];
    let newTagRegex = /New tag:/;

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);

      if (match) {
        releasedPackages.push(pkg);
        if (createGithubReleases) {

          try {
            let changelogContent: Record<'dep' | 'patch' | 'minor' | 'major', string[]> = {
              dep: [],
              patch: [],
              minor: [],
              major: [],
            }
        
              let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");
              let changelog = await fs.readFile(changelogFileName, "utf8");
              let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
        
              if (!changelogEntry) {
                // we can find a changelog but not the entry for this version
                // if this is true, something has probably gone wrong
                throw new Error(
                  `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
                );
              }
              let content = changelogEntry.content.toString()
              let level = changelogEntry.highestLevel
        
              content = content.replace(/^### Patch Changes$/gm, '')
              content = content.replace(/^### Minor Changes$/gm, '')
              content = content.replace(/^### Major Changes$/gm, '')
        
              content = `### ${pkg.packageJson.name}\n ${content}`

              console.log(pkg.packageJson.name, {content, level})
        
              changelogContent[levelToString(level)].push(content)
        
              const tagName = `v${pkg.packageJson.version}`
              const preRelease = pkg.packageJson.version.includes("-")
        
            let finalChangelog: string[] = []
        
            if (changelogContent.major.length) {
              finalChangelog.push(
                `## 🔥 Breaking Changes\n ${changelogContent.major.join('\n\n')}`
              )
            }
        
            if (changelogContent.minor.length) {
              finalChangelog.push(
                `## 🚀 Features/Improvements\n ${changelogContent.minor.join('\n\n')}`
              )
            }
        
            if (changelogContent.patch.length) {
              finalChangelog.push(
                `## 🐞 Patches\n ${changelogContent.patch.join('\n\n')}`
              )
            }

            console.log({changelogContent, finalChangelog})
        
            if (finalChangelog.length) {
              await octokit.repos.createRelease({
                name: tagName,
                tag_name: tagName,
                body: finalChangelog.join('\n\n'),
                prerelease: preRelease,
                ...github.context.repo,
              });
            } else {
              throw new Error("Final Changelong empty")
            }
          } catch (err: any) {
            // if we can't find a changelog, the user has probably disabled changelogs
            if (err.code !== "ENOENT") {
              throw err;
            }
          }

        }
        break;
      }
    }
  }

  if (releasedPackages.length) {
    return {
      published: true,
      publishedPackages: releasedPackages.map((pkg) => ({
        name: pkg.packageJson.name,
        version: pkg.packageJson.version,
      })),
    };
  }

  return { published: false };
}

const requireChangesetsCliPkgJson = (cwd: string) => {
  try {
    return require(resolveFrom(cwd, "@changesets/cli/package.json"));
  } catch (err: any) {
    if (err && err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`
      );
    }
    throw err;
  }
};

type GetMessageOptions = {
  hasPublishScript: boolean;
  branch: string;
  changedPackagesInfo: {
    highestLevel: number;
    private: boolean;
    content: string;
    header: string;
  }[];
  prBodyMaxCharacters: number;
  preState?: PreState;
};

export async function getVersionPrBody({
  hasPublishScript,
  preState,
  changedPackagesInfo,
  prBodyMaxCharacters,
  branch,
}: GetMessageOptions) {
  let messageHeader = `This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and ${hasPublishScript
    ? `the packages will be published to npm automatically`
    : `publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)`
    }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
`;
  let messagePrestate = !!preState
    ? `⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`changeset pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : "";
  let messageReleasesHeading = `# Releases`;

  let fullMessage = [
    messageHeader,
    messagePrestate,
    messageReleasesHeading,
    ...changedPackagesInfo.map((info) => `${info.header}\n\n${info.content}`),
  ].join("\n");

  // Check that the message does not exceed the size limit.
  // If not, omit the changelog entries of each package.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> The changelog information of each package has been omitted from this message, as the content exceeds the size limit.\n`,
      ...changedPackagesInfo.map((info) => `${info.header}\n\n`),
    ].join("\n");
  }

  // Check (again) that the message is within the size limit.
  // If not, omit all release content this time.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> All release information have been omitted from this message, as the content exceeds the size limit.`,
    ].join("\n");
  }

  return fullMessage;
}

type VersionOptions = {
  script?: string;
  githubToken: string;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  hasPublishScript?: boolean;
  prBodyMaxCharacters?: number;
};

type RunVersionResult = {
  pullRequestNumber: number;
};

export async function runVersion({
  script,
  githubToken,
  cwd = process.cwd(),
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  hasPublishScript = false,
  prBodyMaxCharacters = MAX_CHARACTERS_PER_MESSAGE,
}: VersionOptions): Promise<RunVersionResult> {
  let repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  let branch = github.context.ref.replace("refs/heads/", "");
  let versionBranch = `changeset-release/${branch}`;
  let octokit = github.getOctokit(githubToken);
  let { preState } = await readChangesetState(cwd);

  await gitUtils.switchToMaybeExistingBranch(versionBranch);
  await gitUtils.reset(github.context.sha);

  let versionsByDirectory = await getVersionsByDirectory(cwd);

  if (script) {
    let [versionCommand, ...versionArgs] = script.split(/\s+/);
    await exec(versionCommand, versionArgs, { cwd });
  } else {
    let changesetsCliPkgJson = requireChangesetsCliPkgJson(cwd);
    let cmd = semver.lt(changesetsCliPkgJson.version, "2.0.0")
      ? "bump"
      : "version";
    await exec("node", [resolveFrom(cwd, "@changesets/cli/bin.js"), cmd], {
      cwd,
    });

    await exec("pnpm", ["install"], { cwd });
  }

  let searchQuery = `repo:${repo}+state:open+head:${versionBranch}+base:${branch}`;
  let searchResultPromise = octokit.search.issuesAndPullRequests({
    q: searchQuery,
  });
  let changedPackages = await getChangedPackages(cwd, versionsByDirectory);
  let changedPackagesInfoPromises = Promise.all(
    changedPackages.map(async (pkg) => {
      let changelogContents = await fs.readFile(
        path.join(pkg.dir, "CHANGELOG.md"),
        "utf8"
      );

      let entry = getChangelogEntry(changelogContents, pkg.packageJson.version);
      return {
        highestLevel: entry.highestLevel,
        private: !!pkg.packageJson.private,
        content: entry.content,
        header: `## ${pkg.packageJson.name}@${pkg.packageJson.version}`,
      };
    })
  );

  const finalPrTitle = `${prTitle}${!!preState ? ` (${preState.tag})` : ""}`;

  // project with `commit: true` setting could have already committed files
  if (!(await gitUtils.checkIfClean())) {
    const finalCommitMessage = `${commitMessage}${!!preState ? ` (${preState.tag})` : ""
      }`;
    await gitUtils.commitAll(finalCommitMessage);
  }

  await gitUtils.push(versionBranch, { force: true });

  let searchResult = await searchResultPromise;
  console.log(JSON.stringify(searchResult.data, null, 2));

  const changedPackagesInfo = (await changedPackagesInfoPromises)
    .filter((x) => x)
    .sort(sortTheThings);

  let prBody = await getVersionPrBody({
    hasPublishScript,
    preState,
    branch,
    changedPackagesInfo,
    prBodyMaxCharacters,
  });

  if (searchResult.data.items.length === 0) {
    console.log("creating pull request");
    const { data: newPullRequest } = await octokit.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: newPullRequest.number,
    };
  } else {
    const [pullRequest] = searchResult.data.items;

    console.log(`updating found pull request #${pullRequest.number}`);
    await octokit.pulls.update({
      pull_number: pullRequest.number,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: pullRequest.number,
    };
  }

}
