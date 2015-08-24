var fs = require('fs');
var mkdirp = require('mkdirp');
var os = require('os');
var pathUtil = require('path');
var Promise = require('bluebird');
var ts = require('typescript');
var multimatch = require('multimatch');
var filenameToMid = (function () {
    if (pathUtil.sep === '/') {
        return function (filename) {
            return filename;
        };
    }
    else {
        var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
        return function (filename) {
            return filename.replace(separatorExpression, '/');
        };
    }
})();
function getError(diagnostics) {
    var message = 'Declaration generation failed';
    diagnostics.forEach(function (diagnostic) {
        var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        message +=
            ("\n" + diagnostic.file.fileName + "(" + (position.line + 1) + "," + (position.character + 1) + "): ") +
                ("error TS" + diagnostic.code + ": " + diagnostic.messageText);
    });
    var error = new Error(message);
    error.name = 'EmitterError';
    return error;
}
function getFilenames(baseDir, files) {
    return files.map(function (filename) {
        var resolvedFilename = pathUtil.resolve(filename);
        if (resolvedFilename.indexOf(baseDir) === 0) {
            return resolvedFilename;
        }
        return pathUtil.resolve(baseDir, filename);
    });
}
function processTree(sourceFile, replacer) {
    var code = '';
    var cursorPosition = 0;
    function skip(node) {
        cursorPosition = node.end;
    }
    function readThrough(node) {
        code += sourceFile.text.slice(cursorPosition, node.pos);
        cursorPosition = node.pos;
    }
    function visit(node) {
        readThrough(node);
        var replacement = replacer(node);
        if (replacement != null) {
            code += replacement;
            skip(node);
        }
        else {
            ts.forEachChild(node, visit);
        }
    }
    visit(sourceFile);
    code += sourceFile.text.slice(cursorPosition);
    return code;
}
function generate(options, sendMessage) {
    if (sendMessage === void 0) { sendMessage = function () { }; }
    var baseDir = pathUtil.resolve(options.baseDir);
    var eol = options.eol || os.EOL;
    var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
    var indent = options.indent === undefined ? '\t' : options.indent;
    var compilerOptions = {
        declaration: true,
        module: 1 /* CommonJS */,
        newLine: (eol === '\r\n') ? 0 /* CarriageReturnLineFeed */ : 1 /* LineFeed */,
        target: options.target || 2 /* Latest */
    };
    var filenames = getFilenames(baseDir, options.files);
    // load the tsconfig.json from the baseDir (if it exists)
    var tsConfigFilename = pathUtil.join(baseDir, 'tsconfig.json');
    if (fs.existsSync(tsConfigFilename)) {
        var _a = ts.readConfigFile(tsConfigFilename), tsConfig = _a.config, tsConfigError = _a.error;
        if (tsConfigError) {
            return Promise.reject(tsConfigError);
        }
        var configParseResult = ts.parseConfigFile(tsConfig, ts.sys, pathUtil.dirname(tsConfigFilename));
        if (configParseResult.errors.length > 0) {
            return Promise.reject(configParseResult.errors);
        }
        var tsCompilerOptions = configParseResult.options;
        tsCompilerOptions.declaration = true;
        // the eol option will override the line terminator specified in the tsconfig
        if (options.eol) {
            tsCompilerOptions.newLine = (options.eol === '\r\n') ? 0 /* CarriageReturnLineFeed */ : 1 /* LineFeed */;
        }
        else if (tsCompilerOptions.newLine) {
            eol = (tsCompilerOptions.newLine === 0 /* CarriageReturnLineFeed */) ? '\r\n' : '\n';
        }
        // the target option will override the target specified in the tsconfig
        if (options.target) {
            tsCompilerOptions.target = options.target;
        }
        // remove compiler options that don't make sense in the context of declaration generation
        delete tsCompilerOptions.watch;
        delete tsCompilerOptions.diagnostics;
        delete tsCompilerOptions.noEmit;
        compilerOptions = tsCompilerOptions;
        // prepend all the .d.ts files listed in the tsconfig.json to the array of filenames to be
        // processed by the compiler, this is to ensure the compiler is able resolve all public
        // types in .ts files that don't contain reference path comments
        var tsConfigDeclarationFiles = [];
        tsConfig.files.forEach(function (filename) {
            if (filename.slice(-5) === '.d.ts') {
                tsConfigDeclarationFiles.push(pathUtil.resolve(baseDir, filename));
            }
        });
        filenames = tsConfigDeclarationFiles.concat(filenames);
    }
    mkdirp.sync(pathUtil.dirname(options.out));
    //var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
    // note: mode no longer appears to be an option according to the node.d.ts in DefinitelyTyped
    var output = fs.createWriteStream(options.out);
    var host = ts.createCompilerHost(compilerOptions);
    var program = ts.createProgram(filenames, compilerOptions, host);
    function writeFile(filename, data, writeByteOrderMark) {
        // Compiler is emitting the non-declaration file, which we do not care about
        if (filename.slice(-5) !== '.d.ts') {
            return;
        }
        writeDeclaration(ts.createSourceFile(filename, data, compilerOptions.target, true));
    }
    return new Promise(function (resolve, reject) {
        output.on('close', function () { resolve(undefined); });
        output.on('error', reject);
        output.write('//' + eol +
            '// Auto-generated by dts-generator (https://github.com/enlight/dts-generator/)' + eol +
            '//' + eol + eol);
        if (options.externs) {
            options.externs.forEach(function (path) {
                sendMessage("Writing external dependency " + path);
                output.write(("/// <reference path=\"" + path + "\" />") + eol);
            });
        }
        program.getSourceFiles().some(function (sourceFile) {
            // Source file is a default library, or other dependency from another project, that should not be included in
            // our bundled output
            if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
                return;
            }
            if (options.excludes) {
                var relativeFilename = pathUtil.relative(baseDir, sourceFile.fileName);
                var matches = multimatch(relativeFilename, options.excludes);
                if (matches.length !== 0) {
                    sendMessage("Excluding " + relativeFilename);
                    return;
                }
            }
            sendMessage("Processing " + sourceFile.fileName);
            // Source file is already a declaration file so does not need to be pre-processed by the emitter
            if (sourceFile.fileName.slice(-5) === '.d.ts') {
                writeDeclaration(sourceFile);
                return;
            }
            var emitOutput = program.emit(sourceFile, writeFile);
            if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
                reject(getError(emitOutput.diagnostics
                    .concat(program.getSemanticDiagnostics(sourceFile))
                    .concat(program.getSyntacticDiagnostics(sourceFile))
                    .concat(program.getDeclarationDiagnostics(sourceFile))));
                return true;
            }
        });
        if (options.main) {
            output.write(eol + ("declare module '" + options.name + "' {") + eol);
            output.write(indent + ("export * from '" + options.main + "';") + eol);
            output.write('}' + eol);
            sendMessage("Aliased main module " + options.name + " to " + options.main);
        }
        output.end();
    });
    function isExternalModule(sourceFile) {
        return sourceFile.statements.some(function (node) {
            var externalMarker = node.flags & 1 /* Export */
                || node.kind === 219 /* ImportEqualsDeclaration */ && node.moduleReference.kind === 230 /* ExternalModuleReference */
                || node.kind === 220 /* ImportDeclaration */
                || node.kind === 225 /* ExportAssignment */
                || node.kind === 226 /* ExportDeclaration */
                ? node : undefined;
            return externalMarker ? true : false;
        });
    }
    function writeDeclaration(declarationFile) {
        var filename = declarationFile.fileName;
        var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));
        if (isExternalModule(declarationFile)) {
            output.write(eol + ("declare module '" + sourceModuleId + "' {") + eol + indent);
            var content = processTree(declarationFile, function (node) {
                if (node.kind === 230 /* ExternalModuleReference */) {
                    var expression = node.expression;
                    if (expression.text.charAt(0) === '.') {
                        return " require('" + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + "')";
                    }
                }
                else if (node.kind === 120 /* DeclareKeyword */) {
                    return '';
                }
                else if (node.kind === 9 /* StringLiteral */ &&
                    (node.parent.kind === 226 /* ExportDeclaration */ || node.parent.kind === 220 /* ImportDeclaration */)) {
                    var text = node.text;
                    if (text.charAt(0) === '.') {
                        return " '" + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text)) + "'";
                    }
                }
            });
            output.write(content.replace(nonEmptyLineStart, '$&' + indent));
            output.write(eol + '}' + eol);
        }
        else {
            output.write(declarationFile.text);
        }
    }
}
exports.generate = generate;
