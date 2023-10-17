#!/usr/bin/env node

// usage
const yargs = require('yargs')
    .usage('Calculate the npm modules used in this project and generate a third-party attribution (credits) text.',
    {
        outputDir: {
            alias: 'o',
            default: './oss-attribution'
        },
        baseDir: {
            alias: 'b',
            default: process.cwd(),
        }
    })
    .array('baseDir')
    .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory.')
    .example('$0 -b ./some/path/to/projectDir', 'run the tool for Bower/NPM projects in another directory.')
    .example('$0 -o tpn -b ./some/path/to/projectDir', 'run the tool in some other directory and dump the output in a directory called "tpn" there.');

if (yargs.argv.help) {
    yargs.showHelp();
    process.exit(1);
}

// dependencies
const npmChecker = require('license-checker');
const path = require('path');
const jetpack = require('fs-jetpack');
const os = require('os');
const taim = require('taim');
const {promisify} = require('util');

const npmCheckerInit = promisify(npmChecker.init);

// const
const licenseCheckerCustomFormat = {
    name: '',
    version: '',
    description: '',
    repository: '',
    publisher: '',
    email: '',
    url: '',
    licenses: '',
    licenseFile: '',
    licenseModified: false
}

/**
 * Helpers
 */
function getAttributionForAuthor(a) {
    return typeof a === 'string' ? a : a.name + ((a.email || a.homepage || a.url) ? ` <${a.email || a.homepage || a.url}>` : '');
}

async function getNpmLicenses() {
    const npmDirs = Array.isArray(options.baseDir)
      ? options.baseDir
      : npmDirs = [options.baseDir];
    // first - check that this is even an NPM project
    for (let i = 0; i < npmDirs.length; i++) {
        if (!jetpack.exists(path.join(npmDirs[i], 'package.json'))) {
            console.log('directory at "' + npmDirs[i] + '" does not look like an NPM project, skipping NPM checks for path ' + npmDirs[i]);
            return [];
        }
    }
    console.log('Looking at directories: ' + npmDirs)
    const checkers = [];

    for (let i = 0; i < npmDirs.length; i++) {
        const dir = npmDirs[i];
        const checker = await npmCheckerInit({
            start: npmDirs[i],
            production: true,
            customFormat: licenseCheckerCustomFormat
        });
        Object.getOwnPropertyNames(checker).forEach(k => {
            checker[k]['dir'] = dir;
        })
        checkers.push(checker);
    }
    if (checkers.length === 0) {
        return [];
    }

    return Promise.all(checkers)
        .then((raw_result) => {
            // the result is passed in as an array, one element per npmDir passed in
            // de-dupe the entries and merge it into a single object
            let merged = {};
            for (var i = 0; i < raw_result.length; i++) {
                merged = Object.assign(raw_result[i], merged);
            }
            return merged;
        }).then((result) => {

            // we want to exclude the top-level project from being included
            const dir = result[Object.keys(result)[0]]['dir'];
            const topLevelProjectInfo = jetpack.read(path.join(dir, 'package.json'), 'json');
            const keys = Object.getOwnPropertyNames(result).filter((k) => {
                return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`;
            });

            const promises = keys.map((key) => {
                console.log('processing', key);

                const package = result[key];
                const defaultPackagePath = `${package['dir']}/node_modules/${package.name}/package.json`;

                const itemAtPath = jetpack.exists(defaultPackagePath);
                let packagePath = [defaultPackagePath];

                if (itemAtPath !== 'file') {
                  packagePath = jetpack.find(package['dir'], {
                    matching: `**/node_modules/${package.name}/package.json`
                  });
                }

                if (!packagePath || !packagePath[0]) {
                  return Promise.reject(`${package.name}: unable to locate package.json`);
                }

                const packageJson = jetpack.read(packagePath[0], 'json');

                console.log('processing', packageJson.name, 'for authors and licenseText');

                const props = {};

                props.authors =
                  (packageJson.author && getAttributionForAuthor(packageJson.author)) ||
                  (packageJson.contributors && packageJson.contributors
                      .map(c => {

                        return getAttributionForAuthor(c);
                      }).join(', ')) ||
                  (packageJson.maintainers && packageJson.maintainers
                      .map(m => {

                        return getAttributionForAuthor(m);
                      }).join(', '));

                const licenseFile = package.licenseFile;

                try {
                  if (licenseFile && jetpack.exists(licenseFile) && path.basename(licenseFile).match(/license/i)) {
                    props.licenseText = jetpack.read(licenseFile);
                  } else {
                    props.licenseText = '';
                  }
                } catch (e) {
                  console.warn(e);

                  return {
                    authors: '',
                    licenseText: ''
                  };
                }

                return {
                  ignore: false,
                  name: package.name,
                  version: package.version,
                  authors: props.authors,
                  url: package.repository,
                  license: package.licenses,
                  licenseText: props.licenseText
                };
            }, {
                concurrency: os.cpus().length
            });
            return Promise.all(promises);
        });
}

function applyOverrides(outputDir, licenseInfos) {
      const userOverridesPath = path.join(outputDir, 'overrides.json');
      if (jetpack.exists(userOverridesPath)) {
          const userOverrides = jetpack.read(userOverridesPath, 'json');
          console.log('using overrides', userOverrides);
          for (const key of Object.getOwnPropertyNames(userOverrides)) {
              const licenseInfo = licenseInfos.find(licenseInfo => licenseInfo.name == key);
              if (licenseInfo) {
                  const override = userOverrides[key];
                  Object.assign(licenseInfo, override);
              } else {
                  licenseInfo.push(override);
              }
          }
      }
}

/***********************
 *
 * MAIN
 *
 ***********************/

// sanitize inputs
const options = {
    baseDir: [],
    outputDir: path.resolve(yargs.argv.outputDir)
};

for (let i = 0; i < yargs.argv.baseDir.length; i++) {
    options.baseDir.push(path.resolve(yargs.argv.baseDir[i]));
}


taim('Total Processing',
    taim('Npm Licenses', getNpmLicenses()),
)
    .catch((err) => {
        console.log(err);
        process.exit(1);
    })
    .then((licenseInfos) => {
        applyOverrides(options.outputDir, licenseInfos);
        licenseInfos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', ignorePunctuation: true }))
        const attributionSequence =  licenseInfos
            .filter(licenseInfo => !licenseInfo.ignore && licenseInfo.name != undefined)
            .map(licenseInfo => [
                    licenseInfo.name,
                    `${licenseInfo.version} <${licenseInfo.url}>`,
                    licenseInfo.licenseText || `license: ${licenseInfo.license}${os.EOL}authors: ${licenseInfo.authors}`
                ].join(os.EOL)
            );

        const attribution = attributionSequence.join(`${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`);

        const headerPath = path.join(options.outputDir, 'header.txt');

        if (jetpack.exists(headerPath)) {
            const template = jetpack.read(headerPath);
            console.log('using template', template);
            attribution = template + os.EOL + os.EOL + attribution;
        }

        const outputLicenseInfos = {};
        for (const license of licenseInfos) {
            outputLicenseInfos[license.name] = license;
        }

        jetpack.write(path.join(options.outputDir, 'licenseInfos.json'), JSON.stringify(outputLicenseInfos));

        return jetpack.write(path.join(options.outputDir, 'attribution.txt'), attribution);
    })
    .catch(e => {
        console.error('ERROR writing attribution file', e);
        process.exit(1);
    })
    .then(() => {
        console.log('done');
        process.exit();
    });
