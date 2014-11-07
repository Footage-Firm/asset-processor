'use strict';

var fs = require('fs-extra');
var path = require('path');
var crypto = require('crypto');
var zlib    = require('zlib');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var _ = require('underscore');
var async = require('async');
var dir = require('node-dir');
var uglifyjs = require('uglify-js');
var CleanCss = require('clean-css');
var less = require('less');
var request = require('request');

var S3 = require('./s3');

/*
var CONTENT_BUCKET_URI = '//'+env.AMAZON_S3_BUCKET+'.s3.amazonaws.com/';
var CONTENT_BUCKET_FOLDER = 'content';*/

function AssetProcessor(config) {

    var baseRoot;
    var currRelativeRoot;

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
        this.config.targets.images.extensions = ['.png','.jpg','.jpeg','.gif','.bmp'];
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

    currRelativeRoot = this.config.targets.extras && this.config.targets.extras.root; //extra target root (if any)
    this.config.extrasRoot = path.normalize(currRelativeRoot ? path.resolve(baseRoot, currRelativeRoot) : baseRoot); //full path to the local root for extra assets

    // Some other options
    this.forceCdnUpdate = this.config.forceCdnUpdate;
}

util.inherits(AssetProcessor, EventEmitter);

/**
 * Gets array of relevant javascript file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getJavaScriptFiles = function (normalizedFullPath, callback) {
    _getFiles(this.config.targets.javascripts, this.config.javascriptsRoot, normalizedFullPath, callback);
};

/**
 * Gets array of relevant javascript file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getCssFiles = function (normalizedFullPath, callback) {
    _getFiles(this.config.targets.stylesheets, this.config.stylesheetsRoot, normalizedFullPath, callback);
};

/**
 * Gets array of relevant image file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getImageFiles = function (normalizedFullPath, callback) {
    _getFiles(this.config.targets.images, this.config.imagesRoot, normalizedFullPath, callback);
};

/**
 * Gets array of relevant extra file paths based on the AssetProcessor's configuration
 * @param {function} callback function(err, files)
 */
AssetProcessor.prototype.getExtraFiles = function (normalizedFullPath, callback) {
    _getFiles(this.config.targets.extras, this.config.extrasRoot, normalizedFullPath, callback);
};

/**
 * Searches for any .less files associated with the css file configuration and compiles them.
 * @param callback function(err, cssFiles)
 */
AssetProcessor.prototype.compileLessFiles = function(callback) {
    var self = this;
    var lessTargetConfig = JSON.parse(JSON.stringify(this.config.targets.stylesheets)); //shallow copy
    var cssFiles = [];
    // for now lets keep folder structure but only look at .less files
    lessTargetConfig.extensions = ['.less'];

    async.auto({
        getFiles: [function(next) {
            _getFiles(lessTargetConfig, self.config.stylesheetsRoot, true, next);
        }],
        processFiles: ['getFiles', function(next, results) {

            // filter out any directories
            var files = results.getFiles.filter(function(file) {
                return path.extname(file).toLowerCase() === '.less';
            });

            async.eachSeries(files, function(file, eachNext) {

                async.auto({
                    readFile: [function(subNext) {
                        fs.readFile(file, subNext);
                    }],
                    render: ['readFile', function(subNext, results) {
                        less.render(results.readFile.toString(), subNext);
                    }],
                    writeFile: ['render', function(subNext, results) {
                        var cssFile = file.replace(/\.less$/i, '.css');
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
 * Uglifies, compresses, and uploads the JavaScript to S3
 * @param {boolean} excludeSourceMap [optional] if true source map will not be generated and uploaded
 * @param {function} callback function(err, uploadedUrl)
 */
AssetProcessor.prototype.uploadJavaScriptToCdn = function(excludeSourceMap, callback) {

    var self = this;

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
        minify: ['getFiles', function(next, results) {
            var jsFiles = results.getFiles;
            var uglifyResult;
            self.emit('minifyStarted', {type: 'js', files: jsFiles});
            uglifyResult = uglifyjs.minify(results.getFiles, {outSourceMap: !excludeSourceMap});
            next(null, {js: uglifyResult.code, map: uglifyResult.map});
        }],
        compressJs: ['minify', function(next, results) {
            zlib.gzip(results.minify.js, next);
        }],
        uploadJs: ['compressJs', 'getPath', function(next, results) {
            var jsFiles = results.getFiles;
            var gzip = results.compressJs;
            var targetPath = results.getPath;
            var headers = {
                'x-amz-acl':         'public-read',
                'Content-Type':      'application/x-javascript',
                'Content-Encoding':  'gzip',
                'Content-Length':    gzip.length,
                'Cache-Control':     'max-age=31536000' //one year
            };
            self.emit('minifyEnded', {type: 'js', files: jsFiles});
            self.emit('uploadStarted', {type: 'js', target: targetPath, source: 'memory'});
            self.s3.putBuffer(gzip, targetPath, headers, next);
        }],
        uploadMap: ['getPath', function(next, results) {
            var mapPath = results.getPath.replace('.js','.map');
            self.s3.putBuffer(results.minify.map, mapPath, next);
        }],
        uploadCompleted: ['uploadJs', function(next, results) {
            var targetPath = results.getPath;
            self.emit('uploadEnded', {type: 'js', target: targetPath, source: 'memory', url: results.uploadJs});
            next();
        }]
    }, function(err, results) {
        callback(err, results && results.uploadJs);
    });
};

/**
 * Cleans up CSS, combines into one file, compresses it, and uploads it to S3
 * @param {function} callback function(err, cssUrl)
 */
AssetProcessor.prototype.uploadCssToCdn = function(callback) {

    var self = this;

    async.auto({
        getFiles: [function(next) {
            self.getCssFiles(true, next);
        }],
        getPath: ['getFiles', function(next, results) {
            _getCssPath(results.getFiles, next);
        }],
        cleanCss: ['getFiles', function(next, results) {

            var files = results.getFiles;
            var css = '';

            self.emit('minifyStarted', {type: 'css', files: files});

            async.eachSeries(files, function(file, eachNext) {
                var currCss = ''+fs.readFileSync(file);
                currCss = new CleanCss({noAdvanced: true, noRebase: true}).minify(currCss);
                currCss = _rebaseUrls(self, file, currCss); //we do our own special rebasing
                css += currCss+' \n';
                eachNext();
            }, function(err) {
                next(err, css);
            });
        }],
        compressCss: ['cleanCss', function(next, results) {
            zlib.gzip(results.cleanCss, next);
        }],
        uploadCss: ['compressCss', 'getPath', function(next, results) {
            var cssFiles = results.getFiles;
            var gzip = results.compressCss;
            var targetPath = results.getPath;
            var headers = {
                'x-amz-acl':         'public-read',
                'Content-Type':      'text/css',
                'Content-Encoding':  'gzip',
                'Content-Length':    gzip.length,
                'Cache-Control':     'max-age=31536000' //one year
            };

            self.emit('minifyEnded', {type: 'css', files: cssFiles});
            self.emit('uploadStarted', {type: 'css', target: targetPath, source: 'memory'});
            self.s3.putBuffer(gzip, targetPath, headers, next);
        }],
        uploadCompleted: ['uploadCss', function(next, results) {
            var targetPath = results.getPath;
            self.emit('uploadEnded', {type: 'css', target: targetPath, source: 'memory', url: results.uploadCss});
            next();
        }]
    }, function(err, results) {
        callback(err, results && results.uploadCss);
    });
};

/**
 * Uploads images to CDN, maintain same directory structure relative to image root
 * @param {function} callback function(err, imageFolderUri)
 */
AssetProcessor.prototype.uploadImagesToCdn = function(callback) {

    var self = this;

    async.auto({
        getFiles: [function(next) {
            self.getImageFiles(true, next);
        }],
        getFolder: [function(next) {
            _getImageFolder(next);
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

    var self = this;

    async.auto({
        getFiles: [function(next) {
            self.getExtraFiles(true, next);
        }],
        getFolder: [function(next) {
            _getExtrasFolder(next);
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

    var self = this;

    var gitToken = self.config.git && self.config.git.token;
    var imports = self.config.targets && self.config.targets.stylesheets && self.config.targets.stylesheets.imports || {};

    var destDir = path.resolve(self.config.stylesheetsRoot, imports.destination || '');
    var sources = imports.sources || [];
    var numImported = 0;

    if (!fs.existsSync(destDir)) {
        console.log('Creating import directory '+destDir);
        fs.mkdirsSync(destDir);
    }

    console.log('Importing '+sources.length+' css files to '+destDir);

    async.eachSeries(sources, function(source, eachNext) {
        var destPath = path.resolve(destDir, path.basename(source));
        console.log('Importing '+source+' to '+destPath);
        _importFromGit(source, destPath, gitToken, function(err) {
            if (!err) {
                numImported += 1;
            }
            eachNext(err);
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
 */
AssetProcessor.prototype.ensureAssets = function(callback) {

    var self = this;

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
        var result = _.extend({}, results && results.ensureJs, results && results.ensureCss, results && results.ensureImages, results && results.ensureExtras);
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
    var eventEmitter = new EventEmitter();
    async.eachSeries(files, function(file, eachNext) {
        var target = targetFolder+'/'+_stripRoot(file, activeRoot);
        var headers = {
            'x-amz-acl':     'public-read',
            'Cache-Control': 'max-age=1800' //30 minutes
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
    var posixRoot = root && root.replace(/\\/g, '/');
    var index;
    file = file.replace(/\\/g, '/');
    index = file.indexOf(posixRoot);
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

            var directories = config.directories;
            var specificFiles = config.files;

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

            var extensions = config.extensions || [];
            var preference = config.preference || [];
            var exclusions = config.exclude || [];

            _getRelevantFiles(activeRoot, directories, specificFiles, extensions, preference, exclusions, next);
        }],
        normalizeFullPathIfNeeded: ['getRelevantFiles', function(next, results) {
            var files = results.getRelevantFiles;
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
            var files = specificFiles || [];
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
            var files = _.map(results.files, function(file) {
                return _stripRoot(file, root);
            });

            // filter the files
            files = files.filter(function(file) {
                // check against any extension requirements
                var extensionMatch =  _extensionMatch(file, extensions);

                // check against any exclusions
                var excluded = (exclusions || []).some(function(excludePath) {
                    return file.toLowerCase().indexOf(excludePath.toLowerCase()) === 0;
                });

                // if extension matches and not excluded, keep the file!
                return extensionMatch && !excluded;
            });

            // specific file orders will be kept if no preference
            preference = (preference || []).concat(_.map(specificFiles, function(specificFile) {
                return _stripRoot(specificFile, root);
            }));

            // sort based on preference
            files.sort(function(a,b) {
                var preferenceDiff = _preference(preference, a) - _preference(preference, b);
                return preferenceDiff !== 0 ? preferenceDiff : a < b ? -1 : a > b ? 1 : 0;
            });

            // sanity check against preference and specific file configuration
            preference.forEach(function(preferencePath) {
                var fullPath = path.resolve(root, preferencePath);
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

    var i;
    var currPreference;

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

    var hash = crypto.createHash('md5');

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

function _getImageFolder(callback) {
    // for now we will use fixed path
    // use separator as this is initially handled in filesystem land
    var folder = path.sep+'img';
    if (callback) {
        callback(null, folder);
    }
    return folder;
}

function _getExtrasFolder(callback) {
    // for now we will use fixed path
    // use separator as this is initially handled in filesystem land
    var folder = path.sep+'extra';
    if (callback) {
        callback(null, folder);
    }
    return folder;
}

function _hashAndGeneratePath(files, path, extension, callback) {
    async.auto({
        hashFiles: [function(next) {
            _hashFiles(files, next);
        }],
        path: ['hashFiles', function(next, results) {
            var hash = results.hashFiles;
            var uri = path+'/'+hash+extension;
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
            var jsChanged = !results.checkJs;

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
        var result = {
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
            var cssChanged = !results.checkCss;

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
        var result = {
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
                _getImageFolder(next);
            } else {
                _getExtrasFolder(next);
            }
        }],
        hashAndGeneratePath: ['getFiles', 'getFolder', function(next, results) {
            _hashAndGeneratePath(results.getFiles, results.getFolder, '.txt', next);
        }],
        checkFiles: ['hashAndGeneratePath', function(next, results) {
            self.s3.fileExists(results.hashAndGeneratePath, next);
        }],
        updateIfNeeded: ['checkFiles', function(next, results) {
            var filesChanged = !results.checkFiles;
            self.emit('filesChecked', {type: type, changed: filesChanged});

            if (filesChanged) {
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
            var targetPath = results.hashAndGeneratePath;
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
        var result = {};

        // we use the plural of type for results
        type = type+'s';

        result[type+'Url'] = results && results.updateIfNeeded;
        result[type+'Changed'] = !results.checkFiles;

        callback(err, result);
    });

}

/**
 * Rebases urls found within url() functions of the given css file
 * We do this here instead of leveraging CleanCSS because the module didn't seem to do it right
 * @param {object} self the "this" scope of an AssetProcessor
 * @param {string} file the full path to the css file (used to help resolve relative paths)
 * @param {string} css the css to process
 * @returns {string} the css with url() functions rebased
 * @private
 */
function _rebaseUrls(self, file, css) {

    var imgRoot = self.config.imagesRoot; //full path to the local root for image assets
    var imgRebaseRoot = _getImageFolder(); //relative url path to the root for rebased (remote) image assets from within S3 bucket
    var extrasRoot = self.config.extrasRoot; //full path to the local root for extra assets
    var extrasRebaseRoot = _getExtrasFolder(); //relative url path to the root for rebased (remote) extra assets from within S3 bucket
    var activeSourceRoot; // variable to keep track of which source root (imgRoot or extrasRoot) we will be using
    var activeRebaseRoot; // variable to keep track of which rebase root (imgRebaseRoot or extrasRebaseRoot) we will be using

    var normalizedUrl; //url normalized to a file system path
    var assetPath; //full path of the asset
    var rebasedUrl; //rebased url

    // Regular expressions used to test each url found
    var urlRegex = /url\((['"]?([^'"\)]+)['"]?)\)/ig;
    var externalHttpRegex = /^(http(s)?:)?\/\//i;
    var absoluteUrlRegex = /^[\/\\][^\/]/;

    var match;
    var url;
    var startIndex;
    var endIndex;

    file = path.normalize(file);

    while ((match = urlRegex.exec(css)) !== null) {
        url = match[1];
        startIndex = match.index+match[0].indexOf(url); // we want start index of just the actual url
        endIndex = startIndex + url.length;
        activeSourceRoot = null; // the active root of the non-rebased url

        // clean off any quotes from url, as they are not needed
        url = url.replace(/^['"]/, '').replace(/['"]$/, '');

        // we don't want to rebase any external urls, so first check for that
        if (!externalHttpRegex.test(url)) {
            // if here, we are referencing our own files. Lets see if its an image or something extra so we know which root to use.
            normalizedUrl = path.normalize(url);
            if (_extensionMatch(normalizedUrl, self.config.targets.images && self.config.targets.images.extensions)) {
                activeSourceRoot = imgRoot;
                activeRebaseRoot = imgRebaseRoot;
            } else {
                activeSourceRoot = extrasRoot;
                activeRebaseRoot = extrasRebaseRoot;
            }
        }

        // If we have an active source root (root to which we are rebasing) we want to try to rebase
        if (activeSourceRoot) {
            // the asset path will either be absolute location from the root, or relative to the file
            assetPath = absoluteUrlRegex.test(normalizedUrl) ? path.join(activeSourceRoot, normalizedUrl) : path.resolve(path.dirname(file), normalizedUrl);
            if (assetPath.indexOf(activeSourceRoot) === 0) {
                rebasedUrl = self.s3.urlWithBucket(path.join(activeRebaseRoot, assetPath.substr(activeSourceRoot.length)));
                // replace url with rebased one we do so by splicing out match and splicing in url; replacement functions could inadvertently replace repeat urls
                css = css.substr(0, startIndex)+rebasedUrl+css.substr(endIndex);
                // since we've modified the string, indexes may have change. have regex resume searching at end of replaced url
                urlRegex.lastIndex = endIndex;
            } else {
                console.warn('Cannot find expected root '+activeSourceRoot+' in asset path '+assetPath);
            }
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

    var apiUrl = _toGitHubApiSource(sourceUrl);
    var requestOptions = {
        url: apiUrl,
        headers: {
            Authorization: 'token '+accessToken,              // our authentication
            Accept: 'application/vnd.github.v3.raw',          // we want raw response
            'User-Agent': 'NodeBot (+http://videoblocks.com)' // need this or github api will reject us
        }
    };

    var ws = fs.createWriteStream(destPath);

    // Create the streams
    var req = request(requestOptions);

    req.pipe(ws);

    req.on('response', function(response) {
        var err = null;
        var success = response.statusCode === 200;

        if (!success) {
            err = new Error('Error requesting '+apiUrl+'; status code '+response.statusCode);
        }

        callback(err, success);
    });

    req.on('error', function(err) {
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
    var blobRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/[^\/]+\/(.*)$/;
    var match = blobRegex.exec(sourceUrl);
    var org;
    var repo;
    var path;
    if (match) {
        // change to api format
        org = match[1];
        repo = match[2];
        path = match[3];
        sourceUrl = 'https://api.github.com/repos/'+org+'/'+repo+'/contents/'+path;
    }

    if (!sourceUrl.match(/^https:\/\/api\.github\.com\/repos\//)) {
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

module.exports = AssetProcessor;