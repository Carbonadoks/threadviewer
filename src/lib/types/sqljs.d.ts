declare module 'sql.js' {
	export type SqlJsConfig = {
		locateFile?: (filename: string) => string;
	};

	export type SqlStatement = {
		step(): boolean;
		get(): unknown[];
		free(): void;
	};

	export type SqlDatabase = {
		prepare(sql: string): SqlStatement;
		close(): void;
	};

	export type SqlJsStatic = {
		Database: new (data?: Uint8Array) => SqlDatabase;
	};

	export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
