import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ILocalBundling } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const EXCLUDE = ['tests', '.pytest_cache', '.ruff_cache', '__pycache__', 'requirements-dev.txt', 'pyproject.toml'];

/**
 * Installs requirements.txt for the Lambda platform (manylinux, arm64) with the local pip, so bundling
 * does not need Docker. Falls back to Docker bundling if no suitable local Python is available.
 */
class LocalPipBundling implements ILocalBundling {
  constructor(
    private readonly sourceDir: string,
    private readonly pythonVersion: string,
  ) {}

  tryBundle(outputDir: string): boolean {
    const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
    if (!python) return false;

    const pip = spawnSync(
      python,
      [
        '-m',
        'pip',
        'install',
        '--quiet',
        '--disable-pip-version-check',
        '--requirement',
        path.join(this.sourceDir, 'requirements.txt'),
        '--target',
        outputDir,
        '--platform',
        'manylinux2014_aarch64',
        '--implementation',
        'cp',
        '--python-version',
        this.pythonVersion,
        '--only-binary=:all:',
      ],
      { stdio: 'inherit' },
    );
    if (pip.status !== 0) return false;

    for (const entry of fs.readdirSync(this.sourceDir)) {
      if (entry.endsWith('.py')) fs.copyFileSync(path.join(this.sourceDir, entry), path.join(outputDir, entry));
    }
    return true;
  }
}

/** Lambda code asset for a Python function directory containing `requirements.txt` and `*.py` modules. */
export const pythonCode = (sourceDir: string, runtime: lambda.Runtime): lambda.Code => {
  const pythonVersion = runtime.name.replace('python', '');
  return lambda.Code.fromAsset(sourceDir, {
    exclude: EXCLUDE,
    bundling: {
      image: runtime.bundlingImage,
      platform: 'linux/arm64',
      command: ['bash', '-c', 'pip install --quiet -r requirements.txt -t /asset-output && cp -au *.py /asset-output/'],
      local: new LocalPipBundling(sourceDir, pythonVersion),
    },
  });
};
