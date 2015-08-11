// Copyright (c) 2015 Vadim Macagon

// Initial version, could probably be improved.

declare namespace multimatch {
	interface IOptions {
		debug?: boolean;
		nobrace?: boolean;
		noglobstar?: boolean;
		dot?: boolean;
		noext?: boolean;
		nocase?: boolean;
		nonull?: boolean;
		matchBase?: boolean;
		nocomment?: boolean;
		nonegate?: boolean;
		flipNegate?: boolean;
	}
	
	function multimatch(list: string | string[], patterns: string | string[], options?: IOptions): string[];
}

declare module 'multimatch' {
	export = multimatch.multimatch;
}