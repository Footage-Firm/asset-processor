'use strict';

require('dotenv').config();

const _ = require('underscore');
const path = require('path');
const fs = require('fs-extra');
const request = require('request');
const zlib = require('zlib');
const NodeunitAsync = require('nodeunit-async');

const AssetProcessor = require('../lib/assetProcessor');

// create our TestHelper
const th = new NodeunitAsync();

if (_.any(['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET', 'GITHUB_OAUTH_TOKEN'], k => { return _.isUndefined(process.env[k]); })) {
    throw new Error("Missing required configuration. Do you have a .env file?");
}

const credentials = {
    s3: {
        bucket: process.env.S3_BUCKET,
        key: process.env.S3_ACCESS_KEY,
        secret: process.env.S3_SECRET
    },
    git: {
        token: process.env.GITHUB_OAUTH_TOKEN
    }
};

// Common assetProcessor used for majority of tests
const assetProcessor = _assetProcessorForTestConfig('test-config.json');

exports.testGetJavaScriptFiles = function(test) {

    test.expect(1);

    th.runTest(test, {
        getJavaScriptFiles: [function(next) {
            assetProcessor.getJavaScriptFiles(next);
        }],
        assertResult: ['getJavaScriptFiles', function(next, results) {
            const files = results && results.getJavaScriptFiles;
            const expected = [
                'js/js_directory_1/one.js',
                'js/js_directory_2/two.js',
                'js/js_directory_1/three.js',
                'mixed/four.js',
                'mixed/mixed_directory_1/five.js',
                'mixed/mixed_directory_2/six.js',
                'js/js_excluded/shouldBeIncluded.js',
                'js/js_directory_1/anywhere1.js',
                'js/js_directory_2/anywhere2.js',
                'mixed/anywhere5.js',
                'mixed/mixed_directory_1/anywhere3.js',
                'mixed/mixed_directory_2/anywhere4.js'
            ];

            test.deepEqual(expected, files);
            next();
        }]
    });
};

exports.testGetCssFiles = function(test) {

    test.expect(1);

    th.runTest(test, {
        getCssFiles: [function(next) {
            assetProcessor.getCssFiles(next);
        }],
        assertResult: ['getCssFiles', function(next, results) {
            const files = results && results.getCssFiles;
            const expected = [
                'css/css_directory_1/one.css',
                'css/css_directory_2/two.css',
                'css/css_directory_1/three.css',
                'mixed/mixed_directory_1/four.css',
                'css/css_directory_2/five.css',
                'css/css_priority/priority2_butfirst.css',
                'css/css_priority/prioirty1_butsecond.css',
                'css/css_priority/priority3_butthird.css',
                'css/css_directory_1/anywhere1.css',
                'css/css_directory_1/anywhere2.css',
                'css/css_directory_2/anywhere3.css',
                'mixed/mixed_directory_2/anywhere4.css'
            ];
            test.deepEqual(expected, files);
            next();
        }]
    });
};

exports.testGetImageFiles = function(test) {

    test.expect(1);

    th.runTest(test, {
        getImageFiles: [function(next) {
            assetProcessor.getImageFiles(next);
        }],
        assertResult: ['getImageFiles', function(next, results) {
            const files = results && results.getImageFiles;
            const expected = [
                'img/img_directory_1/grey_wash_wall.png',
                'img/img_directory_1/mooning.png',
                'img/img_directory_2/purty_wood.png',
                'img/slash_it.png'
            ];
            test.deepEqual(expected, files);
            next();
        }]
    });
};

exports.testGetExtraFiles = function(test) {

    test.expect(1);

    th.runTest(test, {
        getExtraFiles: [function(next) {
            assetProcessor.getExtraFiles(next);
        }],
        assertResult: ['getExtraFiles', function(next, results) {
            const files = results && results.getExtraFiles;
            const expected = [
                'extra/fonts/FontAwesome.otf',
                'extra/fonts/fontawesome-webfont.eot',
                'extra/fonts/fontawesome-webfont.svg',
                'extra/fonts/fontawesome-webfont.ttf',
                'extra/fonts/fontawesome-webfont.woff',
                'extra/swf/copy_csv_xls.swf'
            ];
            test.deepEqual(expected, files);
            next();
        }]
    });
};

exports.testGetFilesNormalizedFullPaths = function(test) {

    test.expect(1);

    th.runTest(test, {
        getCssFiles: [function(next) {
            assetProcessor.getCssFiles(true, next);
        }],
        assertResult: ['getCssFiles', function(next, results) {
            const files = results && results.getCssFiles;
            test.ok(files[0] && files[0].indexOf(path.join(__dirname, 'test-files', 'css')) === 0);
            next();
        }]
    });
};

exports.testCompileLessFiles = function(test) {

    const filesToCreate = [
        path.join(__dirname, 'test-files', 'css', 'css_directory_1', 'three.css'),
        path.join(__dirname, 'test-files', 'mixed', 'mixed_directory_2', 'anywhere4.css')
    ];


    test.expect(2);

    filesToCreate.forEach(function(file) {
        fs.copySync(file, file+'.deleted');
        fs.unlinkSync(file);
    });

    th.runTest(test, {
        compileLessFiles: [function(next) {
            assetProcessor.compileLessFiles(next);
        }],
        assertResult: ['compileLessFiles', function(next, results) {
            const files = results && results.compileLessFiles || [];
            test.ok(files.some(function(file) {
                return path.basename(file) === 'three.css';
            }));
            test.ok(files.some(function(file) {
                return path.basename(file) === 'anywhere4.css';
            }));

            //TODO: modify nodeunit async to have a per-test teardown; otherwise failure here could screw thing up
            filesToCreate.forEach(function(file) {
                const deletedPath = file+'.deleted';
                if (fs.existsSync(deletedPath)) {
                    fs.copySync(deletedPath ,file);
                    fs.unlinkSync(deletedPath);
                }
            });

            next();
        }]
    });

};

exports.testUploadJavaScriptToCdn = function(test) {

    test.expect(8);

    th.runTest(test, {
        uploadJavaScriptToCdn: [function(next) {
            assetProcessor.uploadJavaScriptToCdn(next);
        }],
        download: ['uploadJavaScriptToCdn', function(next, results) {
            _downloadAndUncompress(results.uploadJavaScriptToCdn, next);
        }],
        assertResult: ['download', function(next, results) {

            const js = results.download && results.download || '';

            test.ok(results.uploadJavaScriptToCdn);
            test.ok(js);
            test.equal(-1, js.indexOf('longVariableName'));
            test.ok(js.indexOf('\n') === -1 || js.indexOf('\n') > 100); // newline added at end of file for source mapping, but none before that
            test.ok(js.indexOf('1') < js.indexOf('2'));
            test.ok(js.indexOf('2') < js.indexOf('3'));
            test.ok(js.indexOf('3') < js.indexOf('4'));
            test.ok(js.indexOf('5') < js.indexOf('6'));

            next();
        }]
    });

};

exports.testUploadJavaScriptToCdn_withErrors = function(test) {

    const otherAssetProcessor = _assetProcessorForTestConfig('test-config-withErrors.json');

    test.expect(2);

    th.runTest(test, {
        uploadJavaScriptToCdn: [function(next) {
            otherAssetProcessor.uploadJavaScriptToCdn(function(err) {
                next(null, err);
            });
        }],
        assertResult: ['uploadJavaScriptToCdn', function(next, results) {

            const err = results.uploadJavaScriptToCdn;

            test.ok(err);
            test.ok(err.message.match(/unexpected token/i));

            next();
        }]
    });

};


exports.testUploadCssToCdn = function(test) {

    test.expect(13);

    th.runTest(test, {
        uploadCssToCdn: [function(next) {
            assetProcessor.uploadCssToCdn(next);
        }],
        download: ['uploadCssToCdn', function(next, results) {
            _downloadAndUncompress(results.uploadCssToCdn, next);
        }],
        assertResult: ['download', function(next, results) {

            const css = results.download && results.download || '';
            const bucket = credentials.s3 && credentials.s3.bucket || 'my-aws-s3-bucket';

            test.ok(results.uploadCssToCdn);

            test.ok(css.indexOf('.one') < css.indexOf('.two'));
            test.ok(css.indexOf('.three') < css.indexOf('.four'));
            test.ok(css.indexOf('.four') < css.indexOf('.five'));
            test.ok(css.indexOf('.five') < css.indexOf('.p2'));
            test.ok(css.indexOf('.p2') < css.indexOf('.p1'));
            test.ok(css.indexOf('.p1') < css.indexOf('.p3'));

            // Tests the URL Rebase
            test.notEqual(-1, css.indexOf('url(/img/img_directory_1/grey_wash_wall.png)'));
            test.notEqual(-1, css.indexOf('url(/img/img_directory_1/mooning.png)'));
            test.notEqual(-1, css.indexOf('url(/extra/fonts/fontawesome-webfont.woff)'));
            test.notEqual(-1, css.indexOf('url(//fonts.googleapis.com/css?family=Roboto:400,300,500,500italic,700,900,400italic,700italic)'));
            test.notEqual(-1, css.indexOf('url(https://themes.googleusercontent.com/static/fonts/opensans/v8/MTP_ySUJH_bn48VBG8sNSnhCUOGz7vYGh680lGh-uXM.woff)'));
            test.ok(css.indexOf('url(data:image/png;base64') > 0);

            next();
        }]
    });
};

exports.testUploadImagesToCdn = function(test) {

    test.expect(2);

    th.runTest(test, {
        uploadImagesToCdn: [function(next) {
            assetProcessor.uploadImagesToCdn(next);
        }],
        download: ['uploadImagesToCdn', function(next, results) {
            const sampleImageUrl = results.uploadImagesToCdn+'/img_directory_2/purty_wood.png';
            request(sampleImageUrl, function(err, response, body) {
                next(err, !err && response.statusCode === 200 && (''+body).length);
            });
        }],
        assertResult: ['download', function(next, results) {

            test.ok(results.uploadImagesToCdn);
            test.ok(results.download > 10000);

            next();
        }]
    });

};

exports.testUploadExtrasToCdn = function(test) {

    test.expect(3);

    th.runTest(test, {
        uploadExtrasToCdn: [function(next) {
            assetProcessor.uploadExtrasToCdn(next);
        }],
        download: ['uploadExtrasToCdn', function(next, results) {
            const sampleImageUrl = results.uploadExtrasToCdn+'/fonts/FontAwesome.otf';
            request(sampleImageUrl, function(err, response, body) {
                next(err, !err && response.statusCode === 200 && (''+body).length);
            });
        }],
        assertResult: ['download', function(next, results) {

            test.ok(results.uploadExtrasToCdn);
            test.ok(results.uploadExtrasToCdn && results.uploadExtrasToCdn.toLowerCase().indexOf('s3') >= 0);
            test.ok(results.download > 10000);

            next();
        }]
    });

};

function _downloadAndUncompress(url, callback) {
    const stream = request(url).pipe(zlib.createGunzip());
    let uncompressed = '';

    stream.on('data', function(data) {
        uncompressed += data;
    });

    stream.on('error', function(err) {
        callback(err);
    });

    stream.on('end', function() {
        callback(null, uncompressed);
    });
}

exports.testEnsureAssets = function(test) {

    test.expect(8);

    th.runTest(test, {
        ensureAssets: [function(next) {
            assetProcessor.ensureAssets(next);
        }],
        assertResult: ['ensureAssets', function(next, results) {
            const ensureResult = results.ensureAssets || {};

            test.notEqual('undefined', typeof ensureResult.jsUrl);
            test.notEqual('undefined', typeof ensureResult.jsChanged);
            test.notEqual('undefined', typeof ensureResult.cssUrl);
            test.notEqual('undefined', typeof ensureResult.cssChanged);
            test.notEqual('undefined', typeof ensureResult.imagesUrl);
            test.notEqual('undefined', typeof ensureResult.imagesChanged);
            test.notEqual('undefined', typeof ensureResult.extrasUrl);
            test.notEqual('undefined', typeof ensureResult.extrasChanged);

            next();
        }]
    });

};

exports.testTargetFiles = function(test) {

    // we will use a different configuration than other tests
    const otherAssetProcessor = _assetProcessorForTestConfig('test-config-2.json');

    test.expect(4);

    th.runTest(test, {
        getJavaScriptFiles: [function(next) {
            otherAssetProcessor.getJavaScriptFiles(next);
        }],
        getCssFiles: [function(next) {
            otherAssetProcessor.getCssFiles(next);
        }],
        getImageFiles: [function(next) {
            otherAssetProcessor.getImageFiles(next);
        }],
        getExtraFiles: [function(next) {
            otherAssetProcessor.getExtraFiles(next);
        }],
        assertResults: ['getJavaScriptFiles', 'getCssFiles', 'getImageFiles', 'getExtraFiles', function(next, results) {

            test.deepEqual(['test/test-files/js/js_directory_1/one.js', 'test/test-files/js/js_directory_2/two.js', 'test/test-files/js/js_directory_1/three.js'], results.getJavaScriptFiles);
            test.deepEqual(['test/test-files/css/css_directory_1/one.css', 'test/test-files/css/css_directory_2/two.css', 'test/test-files/css/css_directory_1/three.css', 'test/test-files/mixed/mixed_directory_1/four.css'], results.getCssFiles);
            test.deepEqual(['test/test-files/img/slash_it.png'], results.getImageFiles);
            test.deepEqual(['test/test-files/extra/swf/copy_csv_xls.swf', 'test/test-files/extra/fonts/FontAwesome.otf'], results.getExtraFiles);

            next();
        }]
    })

};

exports.testUploadExtrasToCdnCloudfront = function(test) {

    // we will use a different configuration than other tests
    const otherAssetProcessor = _assetProcessorForTestConfig('test-config-3.json');

    test.expect(2);

    th.runTest(test, {
        uploadExtrasToCdn: [function(next) {
            otherAssetProcessor.uploadExtrasToCdn(next);
        }],
        assertResult: ['uploadExtrasToCdn', function(next, results) {
            test.ok(results.uploadExtrasToCdn && results.uploadExtrasToCdn.indexOf('cloudfront') >= 0);
            test.ok(results.uploadExtrasToCdn && results.uploadExtrasToCdn.indexOf('dummyCfMapping') >= 0);
            next();
        }]
    });

};

exports.testUseCloudFrontWithoutS3 = function(test) {

    // we will use a different configuration than other tests
    const configPath = path.resolve(__dirname, 'test-files', 'test-config-5.json');
    const config = fs.readJsonFileSync(configPath);
    config.root = path.normalize(path.resolve(path.dirname(configPath), config.root || '.'));
    const otherAssetProcessor = new AssetProcessor(config);
    const opts = { filePath: 'test/out' };

    test.expect(1);

    th.runTest(test, {
        processAssets: [function(next) {
            otherAssetProcessor.processAssets(opts, next);
        }],
        assertResult: ['processAssets', function(next, results) {

            const cssFilePath = path.resolve(opts.filePath, 'css', results.processAssets.cssUrl.split('/').pop());
            const cssFile = fs.readFileSync(cssFilePath).toString();

            // Test url rebase
            test.ok(cssFile.indexOf('/img') >= 0);
            next();
        }]
    });

};

// NOTE: The files this is trying to pull from github do not exist anymore
// exports.testImportLatestStylesheets = function(test) {
//
//     // we will use a different configuration than other tests
//     const otherAssetProcessor = _assetProcessorForTestConfig('test-config-4.json');
//     const importDir = path.resolve(__dirname, 'test-files', 'import');
//
//     const expectedFile1 = path.resolve(importDir, 'audioblocks-style-custom.css');
//     const expectedFile2 = path.resolve(importDir, 'global-style-custom.css');
//
//     if (!credentials.git) {
//         console.warn('With no git credentials this test will fail');
//     }
//
//     // clean up any previous tests
//     if (fs.existsSync(importDir)) {
//         fs.removeSync(importDir);
//     }
//     // simulate existing files
//     fs.mkdirpSync(importDir);
//     fs.writeFileSync(expectedFile1, 'existing file1');
//     fs.writeFileSync(expectedFile2, 'existing file2');
//
//     test.expect(4);
//
//     th.runTest(test, {
//         uploadExtrasToCdn: [function(next) {
//             otherAssetProcessor.importLatestStylesheets(next);
//         }],
//         assertResult: ['uploadExtrasToCdn', function(next) {
//             const css1 = fs.existsSync(expectedFile1) && fs.readFileSync(expectedFile1, 'utf8');
//             const css2 = fs.existsSync(expectedFile2) && fs.readFileSync(expectedFile2, 'utf8');
//
//             test.ok(css1 && css1.length > 1000);
//             test.ok(css1 && css1.indexOf('mapped/path/to/images/home/home-notes-dark-blue.png') > 0);
//             test.ok(css2 && css2.length > 200);
//             test.ok(css2 && css2.indexOf('another/mapping/for/fonts/fontawesome-webfont.eot') > 0);
//
//             next();
//         }]
//     });
//
// };

/**
 * Helper function that creates an AssetProcessor for the given config file
 * @param configFile name of test config file to use
 * @returns {AssetProcessor}
 * @private
 */
function _assetProcessorForTestConfig(configFile) {
    // we will use a different configuration than other tests
    const configPath = path.resolve(__dirname, 'test-files', configFile);
    const config = fs.readJsonFileSync(configPath);

    // mix in secret credentials to hard coded configs
    config.s3 = _.extend(config.s3 || {}, credentials.s3);
    config.git = _.extend(config.git || {}, credentials.git);

    config.root = path.normalize(path.resolve(path.dirname(configPath), config.root || '.'));

    return new AssetProcessor(config);
}
