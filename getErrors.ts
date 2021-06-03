import ghUrl = require("@typescript/github-url");
import packageUtils = require("./packageUtils");
import projectGraph = require("./projectGraph");
import cp = require("child_process");
import path = require("path");

const nodePath = process.argv0;

const errorCodeRegex = /error TS(\d+).*/;
const errorPositionRegex = /^([^(]+)(?:\((\d+))/;
const beginProjectRegex = /Building project '([^']+)'/;

interface BuildOutput {
    stdout: string,
    hasBuildFailure: boolean,
    isEmpty: boolean,
}

interface ExecResult {
    err: cp.ExecException | null,
    stdout: string,
    stderr: string,
}

interface LocalError {
    projectUrl: string,
    code: number,
    text: string,
    path?: string,
    lineNumber?: number,
}

export interface Error {
    /** The URL of the containing project.  May not match the one in ProjectErrors for composite projects. */
    projectUrl: string,
    /** The URL of the containing file, including the line number. */
    fileUrl?: string,
    /** The TypeScript error code. */
    code: number,
    /** The first line of the error message.  No structure guaranteed. */
    text: string,
}

export interface ProjectErrors {
    /** The URL of the root project (i.e. the one to build to repro the errors). */
    projectUrl: string,
    /** True if the root project is composite (i.e. if build mode was used). */
    isComposite: boolean,
    /** True if tsc did not return success. */
    hasBuildFailure: boolean,
    /** Errors extracted from the output of tsc. */
    errors: readonly Error[],
    /** The verbatim output of tsc, for debugging. */
    raw: string,
}

export interface RepoErrors {
    /** True if there was a problem building the project graph from the project files. */
    hasConfigFailure: boolean,
    /** Errors, grouped by root project. */
    projectErrors: readonly ProjectErrors[],
}

/**
 * Given a folder and a compiler, identify buildable projects and compile them.
 * Assumes that package installation has already occurred.
 * @param repoDir Typically, the root folder of a git repository.
 * @param tscPath The path to tsc.js.
 * @param skipLibCheck True pass --skipLibCheck when building non-composite projects.  (Defaults to true)
 */
export async function buildAndGetErrors(repoDir: string, tscPath: string, skipLibCheck: boolean = true): Promise<RepoErrors> {
    const simpleBuildArgs = `--skipLibCheck ${skipLibCheck} --incremental false --pretty false -p`;
    const compositeBuildArgs = `-b -f -v`; // Build mode doesn't support --skipLibCheck or --pretty

    const lernaOrder = await packageUtils.getLernaOrder(repoDir);

    const { simpleProjects, rootCompositeProjects, hasError: hasConfigFailure } = await projectGraph.getProjectsToBuild(repoDir, /*ignoreExtensionErrors*/ true, lernaOrder);
    const projectsToBuild = simpleProjects.concat(rootCompositeProjects);

    if (!projectsToBuild.length) {
        return {
            hasConfigFailure,
            projectErrors: [],
        };
    }

    const projectErrors: ProjectErrors[] = [];

    for (const { path: projectPath, isComposite } of projectsToBuild) {
        const { isEmpty, stdout, hasBuildFailure } = await buildProject(tscPath, isComposite ? compositeBuildArgs : simpleBuildArgs, projectPath);
        if (isEmpty) continue;

        const projectDir = path.dirname(projectPath);
        const projectUrl = await ghUrl.getGithubUrl(projectPath);

        let localErrors: LocalError[] = [];
        let currProjectUrl = projectUrl;

        const lines = stdout.split(/\r\n?|\n/);
        for (const line of lines) {
            const projectMatch = isComposite && line.match(beginProjectRegex);
            if (projectMatch) {
                currProjectUrl = await ghUrl.getGithubUrl(path.resolve(projectDir, projectMatch[1]));
                continue;
            }

            const localError = getLocalErrorFromLine(line, currProjectUrl);
            if (localError) {
                localErrors.push(localError);
            }
        }

        // Handling the project-level errors separately makes it easier to bulk convert the file-level errors to use GH urls
        const errors = localErrors.filter(le => !le.path).map(le => ({ projectUrl: le.projectUrl, code: le.code, text: le.text } as Error));

        const fileLocalErrors = localErrors.filter(le => le.path).map(le => ({ ...le, path:  path.resolve(projectDir, le.path!) }));
        const fileUrls = await ghUrl.getGithubUrls(fileLocalErrors);

        for (let i = 0; i < fileLocalErrors.length; i++) {
            const localError = fileLocalErrors[i];
            errors.push({
                projectUrl: localError.projectUrl,
                code: localError.code,
                text: localError.text,
                fileUrl: fileUrls[i],
            });
        }

        projectErrors.push({
            projectUrl,
            isComposite,
            hasBuildFailure,
            errors: errors,
            raw: stdout,
        });
    }

    return {
        hasConfigFailure,
        projectErrors,
    };
}

function getLocalErrorFromLine(line: string, projectUrl: string): LocalError | undefined {
    const errorCodeMatch = line.match(errorCodeRegex);
    if (errorCodeMatch) {
        const text = errorCodeMatch[0];
        const code = +errorCodeMatch[1];
        const positionMatch = line.match(errorPositionRegex);
        if (positionMatch) {
            const path = positionMatch[1];
            const lineNumber = +positionMatch[2];

            return {
                projectUrl,
                code,
                text,
                path,
                lineNumber,
            };
        }
        else {
            return {
                projectUrl,
                code,
                text,
            };
        }
    }

    return undefined;
}

async function buildProject(tscPath: string, tscArguments: string, projectPath: string): Promise<BuildOutput> {
    const commandLine = `"${nodePath}" --max-old-space-size=3072 "${tscPath}" ${tscArguments} "${path.basename(projectPath)}"`;
    const { err, stdout, stderr } = await execAsync(path.dirname(projectPath), commandLine);
    return {
        stdout,
        hasBuildFailure: !!(err || (stderr && stderr.length && !stderr.match(/debugger/i))), // --inspect prints the debug port to stderr
        isEmpty: !!stdout.match(/TS18003/)
    };
}

async function execAsync(cwd: string, cmdLine: string): Promise<ExecResult> {
    return new Promise((resolve, reject) =>
        cp.exec(cmdLine, { cwd }, (err, stdout, stderr) =>
            resolve({ err, stdout, stderr } as const)));
}