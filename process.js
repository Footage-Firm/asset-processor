'use strict';

var fs = require('fs');
var path = require('path');

try {
    var minimist = require('minimist');
    var async = require('async');
} catch (err) {
    console.error('Error loading dependencies--have you run npm install?');
    throw err;
}

var AssetProcessor = require('./lib/assetProcessor');
var versionChecker = require('./lib/versionChecker');


var args = minimist(process.argv);

var configPath = args.c || args.config;
var config = readConfig(configPath);

var assetProcessor;

// ability to force updating (even if no change detected)
if (args.f || args.force) {
    config.forceCdnUpdate = true;
}

assetProcessor = new AssetProcessor(config);

// Lets always output results of checking for changes
assetProcessor.on('filesChecked', function(ev) {
    console.log(ev.type+' files have '+(!ev.changed ? 'not ' : '')+'changed');
});

// option for verbose output
if (args.v || args.verbose) {
    assetProcessor.on('minifyStarted', function(ev) {
        console.log(ev.type+' minification started');
    });
    assetProcessor.on('minifyEnded', function(ev) {
        console.log(ev.type+' minification ended');
    });
    assetProcessor.on('uploadStarted', function(ev) {
        console.log(ev.type+' upload to '+ev.target+' started');
    });
    assetProcessor.on('uploadEnded', function(ev) {
        console.log(ev.type+' upload finished; now at '+ev.url);
    });

    console.log('Checking if repository is up to date');
}

versionChecker.checkRepoUpToDate(__dirname, function(err, upToDate) {

    if (err) {
        throw err;
    }

    if (args.v || args.verbose) {
        console.log('Repository is'+(!upToDate ? ' not' : '')+' up to date');
    }

    if (!upToDate) {
        console.error('A new version of assetProcessor is available--please update (git pull)');
        process.exit(1);
    }

    async.auto({

        getJavaScriptFiles: [function(next) {
            if (!args['skip-js']) {
                assetProcessor.getJavaScriptFiles(next);
            } else {
                next();
            }
        }],
        importStylesheets: [function(next) {
            if (args['import']) {
                assetProcessor.importLatestStylesheets(next);
            } else {
                next();
            }
        }],
        compileLess: ['importStylesheets', function (next) {
            if (!args['skip-less']) {
                //for now less compiling seems to be broken
                //assetProcessor.compileLessFiles(next);
                next();
            } else {
                next();
            }
        }],
        getCssFiles: ['compileLess', function(next) {
            if (!args['skip-css']) {
                assetProcessor.getCssFiles(next);
            } else {
                next();
            }
        }],
        getImageFiles: [function(next) {
            if (args['list-images']) {
                assetProcessor.getImageFiles(next);
            } else {
                next();
            }
        }],
        getExtraFiles: [function(next) {
            if (args['list-extras']) {
                assetProcessor.getExtraFiles(next);
            } else {
                next();
            }
        }],
        ensureAssets: [function(next) {
            if (args.u || args.upload) {
                console.log('Ensuring assets');
                assetProcessor.ensureAssets(next);
            } else {
                next();
            }
        }],
        formatResult: ['getJavaScriptFiles', 'getCssFiles', 'getImageFiles', 'getExtraFiles', 'ensureAssets', function (next, results) {
            var result = {};
            if (results.getJavaScriptFiles) {
                result.javascripts = results.getJavaScriptFiles;
            }
            if (results.getCssFiles) {
                result.stylesheets = results.getCssFiles;
            }
            if (results.getImageFiles) {
                result.images = results.getImageFiles;
            }
            if (results.getExtraFiles) {
                result.extras = results.getExtraFiles;
            }
            if (results.ensureAssets) {
                result.cdn = results.ensureAssets;
                // we don't want to output if things have changed or not
                if (result.cdn) {
                    delete result.cdn.jsChanged;
                    delete result.cdn.cssChanged;
                    delete result.cdn.imagesChanged;
                    delete result.cdn.extrasChanged;
                }
            }
            result = JSON.stringify(result, undefined, 4);
            next(null, result);
        }],
        writeResult: ['formatResult', function (next, results) {
            // allow the use of convention for asset path names
            var outputFilename = path.basename(configPath, path.extname(configPath)).replace(/(asset)?config$/i, '') + 'Assets.json';

            if (outputFilename === 'Assets.json') {
                // no prefix here, lets make it lowercase
                outputFilename = outputFilename.toLowerCase();
            }

            var outputPath = typeof args.o !== 'undefined'
                ? args.o === true ? path.resolve(path.dirname(configPath), outputFilename)
                : args.o
                : null;

            if (outputPath) {
                // write to file
                console.log('Writing asset file to ' + outputPath);
                fs.writeFile(outputPath, results.formatResult, next);
            } else {
                // output to console
                console.log(results.formatResult);
                next();
            }
        }]
    }, function (err) {
        if (err) {
            throw err;
        }
    });
});

/**
 * Synchronously reads in configuration file, returning the JSON object.
 * @param {String} configPath
 */
function readConfig(configPath) {
    var config = null;

    if (!fs.existsSync(configPath)) {
        throw new Error('No configuration found at '+configPath);
    }
    try {
        config = JSON.parse(fs.readFileSync(configPath));
    } catch (err) {
        console.log('Unable to parse configuration file');
        throw err;
    }

    // Resolve and normalize root; falling back on directory of configuration path if one isn't present
    config.root = path.normalize(path.resolve(path.dirname(configPath), config.root || ''));

    return config;
}