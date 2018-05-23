'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const zlib    = require('zlib');
const EventEmitter = require('events').EventEmitter;
const util = require('util');

const _ = require('underscore');
const async = require('async');
const dir = require('node-dir');
const uglifyjs = require('uglify-js');
const CleanCss = require('clean-css');
const less = require('less');
const request = require('request');

const S3 = require('./s3');

const ONE_YEAR_IN_SECONDS = 31536000;
const THIRTY_DAYS_IN_SECONDS = 2592000;
const SEVEN_DAYS_IN_SECONDS = 604800;

/*
const CONTENT_BUCKET_URI = '//'+env.AMAZON_S3_BUCKET+'.s3.amazonaws.com/';
const CONTENT_BUCKET_FOLDER = 'content';*/

function AssetProcessor(config) {

    let baseRoot;
    let currRelativeRoot;

    this.config = config;

    if (config.s3) {
        this.s3 = new S3(config.s3.bucket, config.s3.key, config.s3.secret);
        if (config.s3.cloudfrontMapping) {
            this.s3.setCloudfrontMapping(config.s3.cloudfrontMapping);
        }
    }
    
    // set default extensions for js, css, and images

    if (this.config.targets.javascripts && !this.config.targets.javascripts.extensions) {
        this.config.targets.javascripts.extensions = ['.js'];
    }
    if (this.config.targets.stylesheets && !this.config.targets.stylesheets.extensions) {
        this.config.targets.stylesheets.extensions = ['.css'];
    }
    if (this.config.targets.images && !this.config.targets.images.extensions) {
        this.config.targets.images.extensions = ['.ico', '.png','.jpg','.jpeg','.gif','.bmp','.svg'];
    }

    // figure out and normalize the relevant roots we are using

    if (!this.config.root) {
        throw new Error('Configuration root is required');
    } else if (!fs.existsSync(this.config.root)) {
        throw new Error('Invalid configuration root');
    }

    this.config.root = path.normalize(this.config.root); //full path that is the base root of the project; target roots are relative to this

    baseRoot = this.config.root;

    currRelativeRoot = this.config.targets.javascripts && this.config.targets.javascripts.root; //image target root (if any)
    this.config.javascriptsRoot = path.normalize(currRelativeRoot ? path.resolve(baseRoot, currRelativeRoot) : baseRoot); //full path to the local root for image assets

    currRelativeRoot = this.config.targets.stylesheets && this.config.targets.stylesheets.root; //image target root (if any)
    this.config.stylesheetsRoot = path.normalize(currRelativeRoot ? path.resolve(baseRoot, currRelativeRoot) : baseRoot); //full path to the local root for image assets

    currRelativeRoot = this.config.targets.images && this.config.targets.images.root; //image target root (if any)
    this.config.imagesRoot = path.normalize(currRelativeRoot ? path.resolve(baseRoot, currRelativeRoot) : baseRoot); //full path to the local root for image assets
    this.config.imagesRootRelative = path.relative(this.config.root, this.config.imagesRoot);

    currRelativeRoot = this.config.targets.extras && this.config.targets.extras.root; //extra target root (if any)
    this.config.extrasRoot = path.normalize(currRelativeRoot ? path.resolve(baseRoot, currRelativeRoot) : baseRoot); //full path to the local root for extra assets
    this.config.extrasRootRelative = path.relative(this.config.root, this.config.extrasRoot);

    // Some other options
    this.forceCdnUpdate = this.config.forceCdnUpdate;
}

util.inherits(AssetProcessor, EventEmitter);

/**
 * Gets array of relevant javascript file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getJavaScriptFiles = function (normalizedFullPath, callback) {
    _getFilesRelativeToRoot(this.config.root, this.config.javascriptsRoot, this.config.targets.javascripts, normalizedFullPath, callback);
};

/**
 * Gets array of relevant javascript file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getCssFiles = function (normalizedFullPath, callback) {
    _getFilesRelativeToRoot(this.config.root, this.config.stylesheetsRoot, this.config.targets.stylesheets, normalizedFullPath, callback);
};

/**
 * Gets array of relevant image file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getImageFiles = function (normalizedFullPath, callback) {
    _getFilesRelativeToRoot(this.config.root, this.config.imagesRoot, this.config.targets.images, normalizedFullPath, callback);
};

/**
 * Gets array of relevant extra file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getExtraFiles = function (normalizedFullPath, callback) {
    _getFilesRelativeToRoot(this.config.root, this.config.extrasRoot, this.config.targets.extras, normalizedFullPath, callback);
};

function _getFilesRelativeToRoot(mainRoot, activeRoot, targets, normalizedFullPath, callback) {
    const relative = path.relative(mainRoot, activeRoot);

    if (typeof normalizedFullPath === 'function') {
        callback = normalizedFullPath;
        normalizedFullPath = false;
    }


    _getFiles(targets, activeRoot, normalizedFullPath, function(err, files) {
        if (normalizedFullPath) {
            // if normalized, no need to modify paths
            callback(err, files);
        } else {
            // if not normalized, make files relative to main root
            // then replace windows "\\" path separator with "/"
            const relativeFiles = _.map(files || [], function (file) {
                return path.join(relative, file).replace(/\\/gi,'/');
            });

            callback(err, relativeFiles);

        }
    });
}

/**
 * Searches for any .less files associated with the css file configuration and compiles them.
 * @param callback function(err, cssFiles)
 */
AssetProcessor.prototype.compileLessFiles = function(callback) {
    const self = this;
    const lessTargetConfig = JSON.parse(JSON.stringify(this.config.targets.stylesheets)); //shallow copy
    const cssFiles = [];
    // for now lets keep folder structure but only look at .less files
    lessTargetConfig.extensions = ['.less'];

    async.auto({
        getFiles: [function(next) {
            _getFiles(lessTargetConfig, self.config.stylesheetsRoot, true, next);
        }],
        processFiles: ['getFiles', function(next, results) {

            // filter out any directories
            const files = results.getFiles.filter(function(file) {
                return path.extname(file).toLowerCase() === '.less';
            });

            async.eachSeries(files, function(file, eachNext) {

                async.auto({
                    readFile: [function(subNext) {
                        fs.readFile(file, subNext);
                    }],
                    render: ['readFile', function(subNext, results) {
                        less.render(results.readFile.toString(), {
                                filename: path.resolve(file)
                            }, subNext);
                    }],
                    writeFile: ['render', function(subNext, results) {
                        const cssFile = file.replace(/\.less$/i, '.css');
                        fs.writeFile(cssFile, results.render, function(err) {
                            if (!err) {
                                cssFiles.push(cssFile);
                            }
                            subNext(err);
                        });
                    }]
                }, function(err) {
                    eachNext(err);
                });
            }, function(err) {
                next(err);
            });
        }]
    }, function(err) {
        callback(err, cssFiles);
    });
};

/**
 * Uglifies and compresses JavaScript
 * @param excludeSourceMap
 * @param callback
 */
AssetProcessor.prototype.processJavaScript = function(excludeSourceMap, callback) {
    const self = this;

    if (typeof excludeSourceMap === 'function') {
        callback = excludeSourceMap;
        excludeSourceMap = false;
    }

    async.auto({
        getFiles: [function(next) {
            self.getJavaScriptFiles(true, next);
        }],
        getPath: ['getFiles', function(next, results) {
            _getJavaScriptPath(results.getFiles, next);
        }],
        minify: ['getPath', function(next, results) {
            const jsFiles = results.getFiles;
            let uglifyResult = {};
            let err;
            const mapPath = results.getPath.replace('.js','.map');
            const publicMapPath = self.s3 ? self.s3.urlWithBucket(mapPath) : mapPath;
            const uglifyOptions = excludeSourceMap ? {} : {outSourceMap: publicMapPath};

            self.emit('minifyStarted', {type: 'js', files: jsFiles});

            if (!jsFiles.length) {
                next(null, {});
            } else {
                try {
                    uglifyResult = uglifyjs.minify(jsFiles, uglifyOptions);
                } catch (uglifyError) {
                    err = uglifyError;
                }

                next(err, { js: uglifyResult && uglifyResult.code, map: uglifyResult.map });
            }


        }]
    }, callback);
}


/**
 * Saves processed JavaScript locally
 * @param callback
 */
AssetProcessor.prototype.saveJavaScriptToFile = function(callback) {

    const self = this;

    async.auto({
        getSource: [function (next) {
            self.processJavaScript(false, next);
        }],
        saveFile: ['getSource', function (next, results) {

            let relativeUrl = "";
            const source = results.getSource.minify.js;

            if (source) {
                const fullLocalPath = self.config.javascriptsRoot + '/' + results.getSource.getPath;
                relativeUrl = '/' + results.getSource.getPath;

                fs.outputFileSync(fullLocalPath, source);
            }

            next(null, relativeUrl);
        }],
    }, function(err, results) {
        const result = {
            jsUrl: results && results.saveFile
        };
        callback(err, result);
    });

};

/**
 * Uglifies, compresses, and uploads the JavaScript to S3
 * @param {boolean=} excludeSourceMap [optional] if true source map will not be generated and uploaded
 * @param {function} callback function(err, uploadedUrl)
 */
AssetProcessor.prototype.uploadJavaScriptToCdn = function(excludeSourceMap, callback) {

    const self = this;

    if (typeof excludeSourceMap === 'function') {
        callback = excludeSourceMap;
        excludeSourceMap = false;
    }

    async.auto({
        getSource: [function(next) {
            self.processJavaScript(excludeSourceMap, next);
        }],
        compressJs: ['getSource', function(next, results) {
            zlib.gzip(results.getSource.minify.js, next);
        }],
        uploadJs: ['compressJs', function(next, results) {
            const jsFiles = results.getSource.getFiles;
            const gzip = results.compressJs;
            const targetPath = results.getSource.getPath;
            const headers = {
                'x-amz-acl':         'public-read',
                'Content-Type':      'application/x-javascript',
                'Content-Encoding':  'gzip',
                'Content-Length':    gzip.length,
                'Cache-Control':     'public, max-age=' + ONE_YEAR_IN_SECONDS
            };
            self.emit('minifyEnded', {type: 'js', files: jsFiles});
            self.emit('uploadStarted', {type: 'js', target: targetPath, source: 'memory'});
            self.s3.putBuffer(gzip, targetPath, headers, next);
        }],
        uploadMap: ['getSource', function(next, results) {
            const mapPath = results.getSource.getPath.replace('.js','.map');
            if (!excludeSourceMap) {
                self.s3.putBuffer(results.getSource.minify.map, mapPath, next);
            } else {
                next();
            }
        }],
        uploadCompleted: ['uploadJs', function(next, results) {
            const targetPath = results.getSource.getPath;
            self.emit('uploadEnded', {type: 'js', target: targetPath, source: 'memory', url: results.uploadJs});
            next();
        }]
    }, function(err, results) {
        callback(err, results && results.uploadJs);
    });
};

AssetProcessor.prototype.processCss = function(callback) {

    const self = this;

    async.auto({
        getFiles: [function(next) {
            self.getCssFiles(true, next);
        }],
        getPath: ['getFiles', function(next, results) {
            _getCssPath(results.getFiles, next);
        }],
        cleanCss: ['getFiles', function(next, results) {

            const files = results.getFiles;
            let css = '';

            self.emit('minifyStarted', {type: 'css', files: files});

            async.eachSeries(files, function(file, eachNext) {
                let currCss = ''+fs.readFileSync(file);
                currCss = new CleanCss({noAdvanced: true, noRebase: true}).minify(currCss);
                currCss = _rebaseUrls(self, file, currCss); //we do our own special rebasing
                css += currCss+' \n';
                eachNext();
            }, function(err) {
                next(err, css);
            });
        }]
    }, callback);
};

AssetProcessor.prototype.saveCssToFile = function(callback) {

    const self = this;

    async.auto({
        getSource: [function(next) {
            self.processCss(next)
        }],
        saveFile: ['getSource', function (next, results) {

            var relativeUrl = "";
            const source = results.getSource.cleanCss;

            if (source) {
                const fullLocalPath = self.config.stylesheetsRoot + '/' + results.getSource.getPath;
                relativeUrl = '/' + results.getSource.getPath;

                fs.outputFileSync(fullLocalPath, source);
            }

            next(null, relativeUrl);
        }],
    }, function(err, results) {
        callback(err, {
            cssUrl: results && results.saveFile
        });
    });

};

/**
 * Cleans up CSS, combines into one file, compresses it, and uploads it to S3
 * @param {function} callback function(err, cssUrl)
 */
AssetProcessor.prototype.uploadCssToCdn = function(callback) {

    const self = this;

    async.auto({
        getSource: [function(next) {
            self.processCss(next)
        }],
        compressCss: ['getSource', function(next, results) {
            zlib.gzip(results.getSource.cleanCss, next);
        }],
        uploadCss: ['compressCss', function(next, results) {
            const cssFiles = results.getSource.getFiles;
            const gzip = results.compressCss;
            const targetPath = results.getSource.getPath;
            const headers = {
                'x-amz-acl':         'public-read',
                'Content-Type':      'text/css',
                'Content-Encoding':  'gzip',
                'Content-Length':    gzip.length,
                'Cache-Control':     'public, max-age=' + ONE_YEAR_IN_SECONDS
            };

            self.emit('minifyEnded', {type: 'css', files: cssFiles});
            self.emit('uploadStarted', {type: 'css', target: targetPath, source: 'memory'});
            self.s3.putBuffer(gzip, targetPath, headers, next);
        }],
        uploadCompleted: ['uploadCss', function(next, results) {
            const targetPath = results.getSource.getPath;
            self.emit('uploadEnded', {type: 'css', target: targetPath, source: 'memory', url: results.uploadCss});
            next();
        }]
    }, function(err, results) {
        callback(err, results && results.uploadCss);
    });
};

AssetProcessor.prototype.processImages = function(callback) {

    const self = this;

    async.auto({
        getFiles: [function(next) {
            self.getImageFiles(true, next);
        }],
        getFolder: [function(next) {
            _getImageFolder(self.config.imagesRootRelative, next);
        }],
    }, callback);
};

/**
 * Uploads images to CDN, maintain same directory structure relative to image root
 * @param {function} callback function(err, imageFolderUri)
 */
AssetProcessor.prototype.uploadImagesToCdn = function(callback) {

    const self = this;

    async.auto({
        getFiles: [function(next) {
            self.getImageFiles(true, next);
        }],
        getFolder: [function(next) {
            _getImageFolder(self.config.imagesRootRelative, next);
        }],
        uploadImages: ['getFiles', 'getFolder', function(next, results) {
            _wrapUploadEmitter(self, _uploadRelativeToRoot(results.getFiles, self.config.imagesRoot, results.getFolder, self.s3, next), 'image');
        }]
    }, function(err, results) {
        callback(err, results && results.uploadImages);
    });
};

/**
 * Uploads extras to CDN, maintain same directory structure relative to extras root
 * @param {function} callback function(err, imageFolderUri)
 */
AssetProcessor.prototype.uploadExtrasToCdn = function(callback) {

    const self = this;

    async.auto({
        getFiles: [function(next) {
            self.getExtraFiles(true, next);
        }],
        getFolder: [function(next) {
            _getExtrasFolder(self.config.extrasRootRelative, next);
        }],
        uploadExtras: ['getFiles', 'getFolder', function(next, results) {
            _wrapUploadEmitter(self, _uploadRelativeToRoot(results.getFiles, self.config.extrasRoot, results.getFolder, self.s3, next), 'extra');
        }]
    }, function(err, results) {
        callback(err, results && results.uploadExtras);
    });
};

/**
 * Imports latest stylesheets
 * @param callback {function} function(err, numImported)
 */
AssetProcessor.prototype.importLatestStylesheets = function(callback) {

    const self = this;

    const gitToken = self.config.git && self.config.git.token;
    const imports = self.config.targets && self.config.targets.stylesheets && self.config.targets.stylesheets.imports || {};

    const destDir = path.resolve(self.config.stylesheetsRoot, imports.destination || '');
    const sources = imports.sources || [];
    const mappings = imports.mappings || {};
    let numImported = 0;

    if (!fs.existsSync(destDir)) {
        console.log('Creating import directory '+destDir);
        fs.mkdirsSync(destDir);
    }

    console.log('Importing '+sources.length+' css files to '+destDir);
    if (Object.keys(mappings).length) {
        console.log('Will be applying the following remappings:', mappings);
    }

    async.eachSeries(sources, function(source, eachNext) {
        const destPath = path.resolve(destDir, path.basename(source));
        console.log('Importing '+source+' to '+destPath);
        _importFromGit(source, destPath, gitToken, function(err) {
            if (!err) {
                _applyImportMappings(destPath, mappings, function(err) {
                    if (!err) {
                        numImported += 1;
                    }
                    eachNext(err);
                });
            } else {
                console.error(err);
                eachNext(err);
            }
        });
    }, function(err) {
        console.log('Imported '+numImported+' of '+sources.length+' stylesheets');
        callback(err, numImported);
    });
};

/**
 * Helper function that listens for and propagates uploadStarted and uploadedEnded events
 * @param {EventEmitter} parentEmitter the parent emitter to propagate from (e.g. AssetProcessor's "this" scope)
 * @param {EventEmitter} childEmitter the child emitter to listen to
 * @param {string} type the type of file being uploaded by the childEmitter
 */
function _wrapUploadEmitter(parentEmitter, childEmitter, type) {
    childEmitter.on('uploadStarted', function(ev) {
        parentEmitter.emit('uploadStarted', {type: type, source: ev.source, target: ev.target});
    });
    childEmitter.on('uploadEnded', function(ev) {
        parentEmitter.emit('uploadEnded', {type: type, source: ev.source, target: ev.target, url: ev.url});
    });
}

/**
 * Ensures latest assets are processed and uploaded
 * @param {function} callback function(err, results)
 * @return {object} result
 * @return {object} result.ensureJs
 * @return {object} result.ensureCss
 * @return {object} result.ensureImages
 * @return {object} result.ensureExtras
 */
AssetProcessor.prototype.ensureAssets = function(callback) {

    const self = this;

    //note: we use artificial dependencies to limit concurrent S3 usage

    async.auto({
        ensureJs: [function(next) {
            _checkAndUpdateJavaScript(self, next);
        }],
        ensureCss: ['ensureJs', function(next) {
            _checkAndUpdateCss(self, next);
        }],
        ensureImages: ['ensureCss', function(next) {
            _checkAndUpdateImages(self, next);
        }],
        ensureExtras: ['ensureImages', function(next) {
            _checkAndUpdateExtras(self, next);
        }]
    }, function(err, results) {
        const result = _.extend({}, results && results.ensureJs, results && results.ensureCss, results && results.ensureImages, results && results.ensureExtras);
        callback(err, result);
    });

};

AssetProcessor.prototype.processAssets = function(callback) {

    const self = this;

    async.auto({
        processJs: [function(next) {
            self.saveJavaScriptToFile(next);
        }],
        processCss: [function(next) {
            self.saveCssToFile(next);
        }]
    }, function(err, results) {

        let result = {};

        if (results) {
            result = _.extend({},
                results.processJs,
                results.processCss,
                {imagesUrl: ''},
                {extrasUrl: ''}
            );
        }

        callback(err, result);
    });

};

/**
 * Helper function to upload files preserving directory structure within a relative root.
 * Calls back with the relative folder path it uploaded directory structure into.
 * @param {string[]} files array of full file paths
 * @param {string} activeRoot full path to the relevant root
 * @param {string} targetFolder path to upload to
 * @param {S3} s3 client doing the uploading
 * @param {function} callback function(err, folderPath)
 * @return {EventEmitter} emitter for upload events
 * @private
 */
function _uploadRelativeToRoot(files, activeRoot, targetFolder, s3, callback) {
    const eventEmitter = new EventEmitter();
    async.eachSeries(files, function(file, eachNext) {
        const target = targetFolder+'/'+_stripRoot(file, activeRoot);
        const headers = {
            'x-amz-acl':     'public-read',
            'Cache-Control': 'public, max-age=' + SEVEN_DAYS_IN_SECONDS
        };
        eventEmitter.emit('uploadStarted', {target: target, source: file});
        s3.putFile(file, target, headers, function(err, result) {
            eventEmitter.emit('uploadEnded', {source: file, target: target, url: result});
            eachNext(err);
        });
    }, function(err) {
        callback(err, s3.urlWithBucket(targetFolder));
    });
    return eventEmitter;
}


/**
 * Helper function that strips a root form the beginning of each file.
 * This will also convert file to use forward slashes
 * @param {string} file path of file from which to strip the root
 * @param {string} root the root path to strip away if file path begins with it
 * @returns {string} file path with the root stripped from each one
 * @private
 */
function _stripRoot(file, root) {
    const posixRoot = root && root.replace(/\\/g, '/');
    file = file.replace(/\\/g, '/');
    const index = file.indexOf(posixRoot);
    if (index !== -1) {
        file = file.substr(posixRoot.length);
        if (file[0] === '/') {
            // if we have a root and the file starts with slash, strip that too so path is relative
            file = file.substr(1);
        }
    }
    return  file;
}

/**
 * Helper function that uses a config paired with defaults to fall back on to get relevant files
 * @param {object} config the configuration for the file type to retrieve
 * @param {string} activeRoot to be used to strip out (or normalize)
 * @param {bool} normalizedFullPath [optional] if true, paths will be full paths (not relative to root) and expanded out (default: false)
 * @param {function} callback function(err, files)
 * @private
 */
function _getFiles(config, activeRoot, normalizedFullPath, callback) {

    if (typeof normalizedFullPath === 'function') {
        callback = normalizedFullPath;
        normalizedFullPath = false;
    }

    async.auto({
        getRelevantFiles: [function(next) {

            let directories = config.directories;
            let specificFiles = config.files;

            if (!directories && !specificFiles) {
                directories = activeRoot;
            }
            if (directories && !(directories instanceof Array)) {
                directories = [directories];
            }

            // need to resolve directory paths relative to root
            directories = _.map(directories || [], function(directory) {
                return path.resolve(activeRoot, directory);
            });

            //need to resolve files relative to root
            specificFiles = _.map(specificFiles || [], function(specificFile) {
                return path.resolve(activeRoot, specificFile);
            });

            const extensions = config.extensions || [];
            const preference = config.preference || [];
            const exclusions = config.exclude || [];

            _getRelevantFiles(activeRoot, directories, specificFiles, extensions, preference, exclusions, next);
        }],
        normalizeFullPathIfNeeded: ['getRelevantFiles', function(next, results) {
            let files = results.getRelevantFiles;
            if (normalizedFullPath) {
                files = _.map(files, function(file) {
                    if (file[0] !== '/') {
                        return path.normalize(path.join(activeRoot, file));
                    }
                });
            }
            next(null, files);
        }]
    }, function(err, results) {
        callback(err, results && results.normalizeFullPathIfNeeded);
    });
}

/**
 * Helper function that recursively searches a directory for relevant files based on any extension, preference, and exclusions.
 * @param {string|} root full path that is the root of the directories
 * @param {string|string[]} directories full path or array of paths to the directory to search; or null if root will be used.
 * @param {string|string[]} specificFiles full path or array of paths to specific files to include.
 * @param {string[]} extensions array of acceptable file extensions or null/empty if all are allowed
 * @param {string[]} preference array of file order that should be enforced or null/empty if no order
 * @param {string[]} exclusions  array of directories and files to exclude
 * @param {function} callback function(err, files)
 * @private
 */
function _getRelevantFiles(root, directories, specificFiles, extensions, preference, exclusions, callback) {

    async.auto({
        files: [function(next) {
            // recurse into all directories to get complete list of files
            let files = specificFiles || [];
            async.each(directories, function(directory, eachNext) {
                dir.files(directory, function(err, dirFiles) {
                    files = files.concat(dirFiles || []);
                    eachNext(err);
                });
            }, function(err) {
                next(err, files);
            });
        }],
        process: ['files', function(next, results) {

            // strip root of file (which will also ensure file path is in posix format)
            let files = _.map(results.files, function(file) {
                return _stripRoot(file, root);
            });

            // filter the files
            files = files.filter(function(file) {
                // check against any extension requirements
                const extensionMatch =  _extensionMatch(file, extensions);

                // check against any exclusions
                const excluded = (exclusions || []).some(function(excludePath) {
                    return file.toLowerCase().indexOf(excludePath.toLowerCase()) === 0;
                });

                // check if the file is included in "preference"
                const included = (preference || []).some(function(preference) {
                    return file.toLowerCase() === preference.toLowerCase();
                });

                let include = false;
                if (included) {
                    include = true;
                } else if (extensionMatch) {
                    include = !excluded;
                }

                // if extension matches and not excluded, keep the file!
                return include; 
            });

            // specific file orders will be kept if no preference
            preference = (preference || []).concat(_.map(specificFiles, function(specificFile) {
                return _stripRoot(specificFile, root);
            }));

            // sort based on preference
            files.sort(function(a,b) {
                const preferenceDiff = _preference(preference, a) - _preference(preference, b);
                return preferenceDiff !== 0 ? preferenceDiff : a < b ? -1 : a > b ? 1 : 0;
            });

            // sanity check against preference and specific file configuration
            preference.forEach(function(preferencePath) {
                const fullPath = path.resolve(root, preferencePath);
                // don't want to warn about extensions we are filtering out
                if (!fs.existsSync(fullPath) && (!path.extname(fullPath) || _extensionMatch(fullPath, extensions))) {
                    console.warn('Warning: '+preferencePath+' was in configuration but cannot be found');
                }
            });

            next(null, files);
        }]
    }, function(err, results) {
        callback(err, results && results.process);
    });
}

/**
 * Helper function that ranks files based on preference
 * @param {string[]} preferences  type of files to get (js|css)
 * @param {string} fileName the relative name of the file being ranked
 * @returns {number} the rank of the file taking into account order preference
 * @private
 */
function _preference(preferences, fileName) {

    let i;
    let currPreference;

    fileName = fileName.toLowerCase(); // Lets do case-insensitive file names

    for (i = 0; i < preferences.length; i += 1) {
        currPreference = preferences[i].toLowerCase();
        if (path.extname(currPreference)) {
            //preference is a file, lets see if we have an exact match
            if (currPreference === fileName) {
                break;
            }
        } else {
            // preference is a directory, see if its contained in it
            // we know the directory is contained if we never have to traverse up
            if (path.relative(currPreference, fileName).indexOf('..') === -1) {
                break;
            }
        }
    }

    return i;
}

/**
 * Computes a hash of the given files
 * @param {string[]} files array of full paths of the files to hash
 * @param {function} callback function(err, hash)
 * @private
 */
function _hashFiles(files, callback) {

    const hash = crypto.createHash('md5');

    async.eachSeries(files, function(file, eachNext) {
        fs.readFile(file, function(err, data) {
            hash.update(data);
            eachNext(err);
        });
    }, function(err) {
        callback(err, !err && files.length && hash.digest('hex'));
    });
}

function _getJavaScriptPath(files, callback) {
    _hashAndGeneratePath(files, 'js', '.js', callback);
}

function _getCssPath(files, callback) {
    _hashAndGeneratePath(files, 'css', '.css', callback);
}

function _getImageFolder(imagesRootRelative, callback) {
    return _firstDirNameFromRootPath(imagesRootRelative, 'img', callback);
}

function _getExtrasFolder(extrasRootRelative, callback) {
    return _firstDirNameFromRootPath(extrasRootRelative, 'extra', callback);
}

function _firstDirNameFromRootPath(rootPath, defaultDirName, callback) {
    const folder = path.sep+(_firstDirName(rootPath) || defaultDirName);
    if (callback) {
        callback(null, folder);
    }
    return folder;
}

function _firstDirName(dirPath) {
    dirPath = (dirPath || '').replace(/[\\\/]/g, path.sep);

    if (dirPath[0] === path.sep) {
        dirPath = dirPath.substr(1);
    }

    return dirPath.split(path.sep)[0] || '';
}

function _hashAndGeneratePath(files, path, extension, callback) {
    async.auto({
        hashFiles: [function(next) {
            _hashFiles(files, next);
        }],
        path: ['hashFiles', function(next, results) {
            const hash = results.hashFiles;
            const uri = path+'/'+hash+extension;
            next(null, uri);
        }]
    }, function(err, results) {
        callback(err, results && results.path);
    });
}

function _checkAndUpdateJavaScript(self, callback) {

    async.auto({
        getJsFiles: [function (next) {
            self.getJavaScriptFiles(true, next);
        }],
        getJsPath: ['getJsFiles', function (next, results) {
            _getJavaScriptPath(results.getJsFiles, next);
        }],
        checkJs: ['getJsPath', function (next, results) {
            self.s3.fileExists(results.getJsPath, next);
        }],
        updateJsIfNeeded: ['checkJs', function (next, results) {
            const jsChanged = !results.checkJs;

            self.emit('filesChecked', {type: 'js', changed: jsChanged});

            if (jsChanged || self.forceCdnUpdate) {
                // time to update javascript
                self.uploadJavaScriptToCdn(function (err, newUrl) {
                    next(err, newUrl);
                });
            } else {
                // no update needed
                next(null, self.s3.urlWithBucket(results.getJsPath));
            }
        }]
    }, function(err, results) {
        const result = {
            jsUrl: results && results.updateJsIfNeeded,
            jsChanged: results && !results.checkJs
        };
        callback(err, result);
    });
}

function _checkAndUpdateCss(self, callback) {

    async.auto({
        getCssFiles: [function (next) {
            self.getCssFiles(true, next);
        }],
        getCssPath: ['getCssFiles', function (next, results) {
            _getCssPath(results.getCssFiles, next);
        }],
        checkCss: ['getCssPath', function (next, results) {
            self.s3.fileExists(results.getCssPath, next);
        }],
        updateCssIfNeeded: ['checkCss', function (next, results) {
            const cssChanged = !results.checkCss;

            self.emit('filesChecked', {type: 'css', changed: cssChanged});

            if (cssChanged || self.forceCdnUpdate) {
                // time to update css
                self.uploadCssToCdn(function (err, newUrl) {
                    next(err, newUrl);
                });
            } else {
                // no update needed
                next(null, self.s3.urlWithBucket(results.getCssPath));
            }
        }]
    }, function(err, results) {
        const result = {
            cssUrl: results && results.updateCssIfNeeded,
            cssChanged: results && !results.checkCss
        };
        callback(err, result);
    });
}

function _checkAndUpdateImages(self, callback) {
    _checkRelativeToRoot(self, 'image', callback);
}

function _checkAndUpdateExtras(self, callback) {
    _checkRelativeToRoot(self, 'extra', callback);
}

function _checkRelativeToRoot(self, type, callback) {

    async.auto({
        getFiles: [function(next) {
            if (type === 'image') {
                self.getImageFiles(true, next);
            } else {
                self.getExtraFiles(true, next);
            }
        }],
        getFolder: [function(next) {
            if (type === 'image') {
                _getImageFolder(self.config.imagesRootRelative, next);
            } else {
                _getExtrasFolder(self.config.extrasRootRelative, next);
            }
        }],
        hashAndGeneratePath: ['getFiles', 'getFolder', function(next, results) {
            _hashAndGeneratePath(results.getFiles, results.getFolder, '.txt', next);
        }],
        checkFiles: ['hashAndGeneratePath', function(next, results) {
            self.s3.fileExists(results.hashAndGeneratePath, next);
        }],
        updateIfNeeded: ['checkFiles', function(next, results) {
            const filesChanged = !results.checkFiles;
            self.emit('filesChecked', {type: type, changed: filesChanged});

            if (filesChanged || self.forceCdnUpdate) {
                if (type === 'image') {
                    self.uploadImagesToCdn(next);
                } else {
                    self.uploadExtrasToCdn(next);
                }
            } else {
                next(null, self.s3.urlWithBucket(results.getFolder));
            }
        }],
        uploadIndicatorFileIfNeeded: ['updateIfNeeded', function(next, results) {
            const targetPath = results.hashAndGeneratePath;
            if (!results.checkFiles) {
                self.emit('uploadStarted', {type: type, target: targetPath, source: 'memory'});
                self.s3.putBuffer(results.getFiles.join('\n'), targetPath, function(err, result) {
                    self.emit('uploadEnded', {type: type, target: targetPath, source: 'memory', url: result});
                    next(err);
                });
            } else {
                next();
            }
        }]
    }, function(err, results) {
        const result = {};

        // we use the plural of type for results
        type = type+'s';

        result[type+'Url'] = results && results.updateIfNeeded;
        result[type+'Changed'] = !results.checkFiles;

        callback(err, result);
    });

}

/**
 * Rebases urls found within url() in our CSS to be relative to the stylesheet. This
 * allows our assets to be properly linked no matter where they are hosted.
 * 
 * @param {object} self the "this" scope of an AssetProcessor
 * @param {string} file the full path to the css file (used to help resolve relative paths)
 * @param {string} css the css to process
 * @returns {string} the css with url() functions rebased
 * @private
 */
function _rebaseUrls(self, file, css) {

    let activeSourceRoot; // variable to keep track of which source root (imgRoot or extrasRoot) we will be using
    let activeRebaseRoot; // variable to keep track of which rebase root (imgRebaseRoot or extrasRebaseRoot) we will be using

    let normalizedUrl; //url normalized to a file system path
    let assetPath; //full path of the asset
    let rebasedUrl; //rebased url

    // Regular expressions used to test each url found
    const urlRegex = /url\((['"]?([^'"\)]+)['"]?)\)/ig;
    const externalHttpRegex = /^(http(s)?:)?\/\//i;
    const absoluteUrlRegex = /^[\/\\][^\/]/;
    const base64Regex = /^data:.+;base64/i;

    let match;
    let url;
    let startIndex;
    let endIndex;

    file = path.normalize(file);

    while ((match = urlRegex.exec(css)) !== null) {
        url = match[1];
        startIndex = match.index+match[0].indexOf(url); // we want start index of just the actual url
        endIndex = startIndex + url.length;

        // clean off any quotes from url, as they are not needed
        url = url.replace(/^['"]/, '').replace(/['"]$/, '');

        // we don't want to rebase any external urls, so first check for that
        if (!externalHttpRegex.test(url) && !base64Regex.test(url)) {

            // if here, we are referencing our own files. Lets see if its an image or something extra so we know which root to use.
            normalizedUrl = path.normalize(url);

            // the asset path will either be absolute location from the root, or relative to the file
            if (absoluteUrlRegex.test(normalizedUrl)) {
                // If the path is abosolute, leave it, as it is already url safe
                /**
                 * If the path is abosolute we can leave it as is, since it is already
                 * a web safe url. 
                 * 
                 * -- Example --
                 * Asset in CSS: '/images/logo.png'
                 */
                rebasedUrl = normalizedUrl
            } else {
                /**
                 * If we have a relative asset in our CSS we are going to resolve it 
                 * to its local path and then make it an absolute web path based on 
                 * the css root path.
                 * 
                 * -- Example --
                 * CSS: /app/public/stylesheet/styles.css
                 * Asset Path in CSS: ../images/logo.png
                 * Resolved Local Path: /app/public/images/logo.png
                 * Resolved Web Path: /images/logo.png
                 */
                rebasedUrl = path
                    .resolve(path.dirname(file), normalizedUrl)
                    .replace(cssRoot, '');
            }

            console.log(rebasedUrl);

            // replace url with rebased one we do so by splicing out match and splicing in url; replacement functions could inadvertently replace repeat urls
            css = css.substr(0, startIndex) + rebasedUrl + css.substr(endIndex);

            // since we've modified the string, indexes may have change. have regex resume searching at end of replaced url
            urlRegex.lastIndex = endIndex;
        }
    }

    return css;
}

/**
 * Imports a file from a github repo to the file system
 * @param sourceUrl {string} url to the file to import
 * @param destPath {string} path to save the file
 * @param accessToken {string} github access token used to request file
 * @param callback {function} function(err, importSuccess)
 * @private
 */
function _importFromGit(sourceUrl, destPath, accessToken, callback) {

    const apiUrl = _toGitHubApiSource(sourceUrl);
    const requestOptions = {
        url: apiUrl,
        headers: {
            Authorization: 'token '+accessToken,              // our authentication
            Accept: 'application/vnd.github.v3.raw',          // we want raw response
            'User-Agent': 'NodeBot (+http://videoblocks.com)' // need this or github api will reject us
        }
    };

    const ws = fs.createWriteStream(destPath);

    // Create the streams
    const req = request(requestOptions);
    let statusCode;
    let reqErr;

    req.on('response', function(response) {
        statusCode = response.statusCode;
    });

    req.on('end', function() {
        const success = statusCode === 200;
        reqErr = reqErr || (!success ? new Error('Error requesting '+apiUrl+'; status code '+statusCode) : null);
    });

    req.on('error', function(err) {
        reqErr = reqErr || err;
    });

    ws.on('close', function() {
        const success = statusCode === 200;
        callback(reqErr, success);
    });

    req.pipe(ws);
}

function _applyImportMappings(filePath, mappings, callback) {

    async.auto({
        readFile: [function(next) {
            fs.readFile(filePath, 'utf8', next);
        }],
        replaceMappings: ['readFile', function(next, results) {
            let css = results.readFile;

            Object.keys(mappings || {}).forEach(function(importedRoot) {
                const search = _escapeRegExp(importedRoot);
                const replacement = mappings[importedRoot];
                css = css.replace(new RegExp(search, 'g'), replacement);
            });

            next(null, css);
        }],
        writeFile: ['replaceMappings', function(next, results) {
            const remappedCss = results.replaceMappings;
            fs.writeFile(filePath, remappedCss, next);
        }]
    }, function(err) {
        callback(err);
    });
}

/**
 * Changes web urls for files on github to be compliant with the github API
 * Examples:
 *     https://github.com/Footage-Firm/StockBlocks/blob/master/assets/common/stylesheets/admin/on_off.css ->
 *         https://api.github.com/repos/Footage-Firm/StockBlocks/contents/assets/common/stylesheets/admin/on_off.css
 *
 * @param sourceUrl {string}
 * @private
 */
function _toGitHubApiSource(sourceUrl) {

    // web url is of format http://github.com/<org>/<repo>/blob/<branch>/<path>
    const gitHubBlobUrlRegex = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/[^\/]+\/(.*)$/;
    const match = gitHubBlobUrlRegex.exec(sourceUrl);
    let org;
    let repo;
    let path;
    if (match) {
        // change to api format
        org = match[1];
        repo = match[2];
        path = match[3];
        sourceUrl = 'https://api.github.com/repos/'+org+'/'+repo+'/contents/'+path;
    }

    if (!sourceUrl.match(/^https?:\/\/api\.github\.com\/repos\//)) {
        throw new Error('Invalid github import source URL: '+sourceUrl);
    }

    return sourceUrl;
}

/**
 * Helper function to see if a path points to a file whose extension (case-insensitive) matches one of many possibilities.
 * If no extensions provided its considered a wildcard match.
 * @param {string} filePath path to the file
 * @param {string[]} extensions the possible extensions
 * @returns {boolean} whether or not an extension matched
 * @private
 */
function _extensionMatch(filePath, extensions) {
    filePath = (filePath || '').toLowerCase();
    return !extensions || !extensions.length || extensions.some(function(extension) {
                                                       return path.extname(filePath).toLowerCase() === extension.toLowerCase();
                                                   });
}

function _escapeRegExp(string) {
    return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

module.exports = AssetProcessor;
