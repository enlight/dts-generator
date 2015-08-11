import fs = require('fs');
import mkdirp = require('mkdirp');
import os = require('os');
import pathUtil = require('path');
import Promise = require('bluebird');
import ts = require('typescript');

interface Options {
	baseDir: string;
	files: string[];
	excludes?: string[];
	externs?: string[];
	eol?: string;
	includes?: string[];
	indent?: string;
	main?: string;
	name: string;
	out: string;
	target?: ts.ScriptTarget;
}

var filenameToMid:(filename: string) => string = (function () {
	if (pathUtil.sep === '/') {
		return function (filename: string) {
			return filename;
		};
	}
	else {
		var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
		return function (filename: string) {
			return filename.replace(separatorExpression, '/');
		};
	}
})();

function getError(diagnostics: ts.Diagnostic[]) {
	var message = 'Declaration generation failed';

	diagnostics.forEach(function (diagnostic) {
		var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

		message +=
			`\n${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): ` +
			`error TS${diagnostic.code}: ${diagnostic.messageText}`;
	});

	var error = new Error(message);
	error.name = 'EmitterError';
	return error;
}

function getFilenames(baseDir: string, files:string[]): string[] {
	return files.map(function (filename) {
		var resolvedFilename = pathUtil.resolve(filename);
		if (resolvedFilename.indexOf(baseDir) === 0) {
			return resolvedFilename;
		}

		return pathUtil.resolve(baseDir, filename);
	});
}

function processTree(sourceFile: ts.SourceFile, replacer:(node: ts.Node) => string): string {
	var code = '';
	var cursorPosition = 0;

	function skip(node: ts.Node) {
		cursorPosition = node.end;
	}

	function readThrough(node: ts.Node) {
		code += sourceFile.text.slice(cursorPosition, node.pos);
		cursorPosition = node.pos;
	}

	function visit(node: ts.Node) {
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

export function generate(options: Options, sendMessage: (message: string) => void = function () {}): Promise<void> {
	var baseDir = pathUtil.resolve(options.baseDir);
	var eol = options.eol || os.EOL;
	var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
	var indent = options.indent === undefined ? '\t' : options.indent;
	let compilerOptions: ts.CompilerOptions = {
		declaration: true,
		module: ts.ModuleKind.CommonJS,
		newLine: (eol === '\r\n') ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed,
		target: options.target || ts.ScriptTarget.Latest
	};

	var filenames = getFilenames(baseDir, options.files);
	var excludesMap: { [filename: string]: boolean; } = {};
	options.excludes && options.excludes.forEach(function (filename) {
		excludesMap[filenameToMid(pathUtil.resolve(baseDir, filename))] = true;
	});

	// load the tsconfig.json from the baseDir (if it exists)
	const tsConfigFilename = pathUtil.join(baseDir, 'tsconfig.json');
	if (fs.existsSync(tsConfigFilename)) {
		const { config: tsConfig, error: tsConfigError } = ts.readConfigFile(tsConfigFilename);
		if (tsConfigError) {
			return Promise.reject(tsConfigError);
		}
		
		const tsCompilerOptions: ts.CompilerOptions = tsConfig.compilerOptions;
		tsCompilerOptions.declaration = true;
		// the eol option will override the line terminator specified in the tsconfig
		if (options.eol) {
			tsCompilerOptions.newLine = (options.eol === '\r\n') ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed;
		} else if (tsCompilerOptions.newLine) {
			eol = (tsCompilerOptions.newLine === ts.NewLineKind.CarriageReturnLineFeed) ? '\r\n' : '\n';
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
		let tsConfigDeclarationFiles: string[] = [];
		(<Array<string>> tsConfig.files).forEach((filename) => {
			if (filename.slice(-5) === '.d.ts') {
				tsConfigDeclarationFiles.push(pathUtil.resolve(baseDir, filename));
			}
		});
		filenames = tsConfigDeclarationFiles.concat(filenames);
	}
	
	mkdirp.sync(pathUtil.dirname(options.out));
	//var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
	// note: mode no longer appears to be an option according to the node.d.ts in DefinitelyTyped
	const output = fs.createWriteStream(options.out);

	var host = ts.createCompilerHost(compilerOptions);
	const program = ts.createProgram(filenames, compilerOptions, host);

	function writeFile(filename: string, data: string, writeByteOrderMark: boolean) {
		// Compiler is emitting the non-declaration file, which we do not care about
		if (filename.slice(-5) !== '.d.ts') {
			return;
		}

		writeDeclaration(ts.createSourceFile(filename, data, compilerOptions.target, true));
	}

	return new Promise<void>(function (resolve, reject) {
		output.on('close', () => { resolve(undefined); });
		output.on('error', reject);

		output.write(
			'//' + eol +
			'// Auto-generated by dts-generator (https://github.com/enlight/dts-generator/)' + eol +
			'//' + eol + eol
		);

		if (options.externs) {
			options.externs.forEach(function (path: string) {
				sendMessage(`Writing external dependency ${path}`);
				output.write(`/// <reference path="${path}" />` + eol);
			});
		}

		program.getSourceFiles().some(function (sourceFile) {
			// Source file is a default library, or other dependency from another project, that should not be included in
			// our bundled output
			if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
				return;
			}

			if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
				return;
			}

			sendMessage(`Processing ${sourceFile.fileName}`);

			// Source file is already a declaration file so does not need to be pre-processed by the emitter
			if (sourceFile.fileName.slice(-5) === '.d.ts') {
				writeDeclaration(sourceFile);
				return;
			}

			var emitOutput = program.emit(sourceFile, writeFile);
			if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
				reject(getError(
					emitOutput.diagnostics
						.concat(program.getSemanticDiagnostics(sourceFile))
						.concat(program.getSyntacticDiagnostics(sourceFile))
						.concat(program.getDeclarationDiagnostics(sourceFile))
				));

				return true;
			}
		});

		if (options.main) {
			output.write(eol + `declare module '${options.name}' {` + eol);
			output.write(indent + `export * from '${options.main}';` + eol);
			output.write('}' + eol);
			sendMessage(`Aliased main module ${options.name} to ${options.main}`);
		}

		output.end();
	});

	function isExternalModule(sourceFile: ts.SourceFile): boolean {
		return sourceFile.statements.some(node => {
            const externalMarker = node.flags & ts.NodeFlags.Export
				|| node.kind === ts.SyntaxKind.ImportEqualsDeclaration && (<ts.ImportEqualsDeclaration>node).moduleReference.kind === ts.SyntaxKind.ExternalModuleReference
				|| node.kind === ts.SyntaxKind.ImportDeclaration
				|| node.kind === ts.SyntaxKind.ExportAssignment
				|| node.kind === ts.SyntaxKind.ExportDeclaration
				? node : undefined;
			return externalMarker ? true : false;
		});
	}
	
	function writeDeclaration(declarationFile: ts.SourceFile) {
		var filename = declarationFile.fileName;
		var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));

		if (isExternalModule(declarationFile)) {
			output.write(eol + `declare module '${sourceModuleId}' {` + eol + indent);

			var content = processTree(declarationFile, function (node) {
				if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
					var expression = <ts.LiteralExpression> (<ts.ExternalModuleReference> node).expression;

					if (expression.text.charAt(0) === '.') {
						return " require('" + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + "')";
					}
				}
				else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
					return '';
				}
				else if (
					node.kind === ts.SyntaxKind.StringLiteral &&
					(node.parent.kind === ts.SyntaxKind.ExportDeclaration || node.parent.kind === ts.SyntaxKind.ImportDeclaration)
				) {
					var text = (<ts.StringLiteral> node).text;
					if (text.charAt(0) === '.') {
						return ` '${filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text))}'`;
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
