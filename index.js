const path = require('path');
const relative = require('require-relative');
const { createFilter } = require('@rollup/pluginutils');
const { compile, preprocess } = require('svelte/compiler');

const PREFIX = '[rollup-plugin-svelte]';
const pkg_export_errors = new Set();

const plugin_options = new Set([
	'emitCss',
	'exclude',
	'extensions',
	'include',
	'onwarn',
	'preprocess'
]);

/**
 * @param [options] {Partial<import('.').Options>}
 * @returns {import('rollup').Plugin}
 */
module.exports = function (options = {}) {
	const { compilerOptions={}, ...rest } = options;
	const extensions = rest.extensions || ['.svelte'];
	const filter = createFilter(rest.include, rest.exclude);

	compilerOptions.format = 'esm';

	for (const key in rest) {
		if (plugin_options.has(key)) continue;
		console.warn(`${PREFIX} Unknown "${key}" option. Please use "compilerOptions" for any Svelte compiler configuration.`);
	}

	// [filename]:[chunk]
	const cache_emit = new Map;
	const { onwarn, emitCss=true } = rest;

	if (emitCss) {
		if (compilerOptions.css) {
			console.warn(`${PREFIX} Forcing \`"compilerOptions.css": false\` because "emitCss" was truthy.`);
		}
		compilerOptions.css = false;
	}

	return {
		name: 'svelte',

		/**
		 * Resolve an import's full filepath.
		 */
		resolveId(importee, importer) {
			if (cache_emit.has(importee)) return importee;
			if (!importer || importee[0] === '.' || importee[0] === '\0' || path.isAbsolute(importee)) return null;

			// if this is a bare import, see if there's a valid pkg.svelte
			const parts = importee.split('/');

			let dir, pkg, name = parts.shift();
			if (name && name[0] === '@') {
				name += `/${parts.shift()}`;
			}

			try {
				const file = `${name}/package.json`;
				const resolved = relative.resolve(file, path.dirname(importer));
				dir = path.dirname(resolved);
				pkg = require(resolved);
			} catch (err) {
				if (err.code === 'MODULE_NOT_FOUND') return null;
				if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
					pkg_export_errors.add(name);
					return null;
				}
				throw err;
			}

			// use pkg.svelte
			if (parts.length === 0 && pkg.svelte) {
				return path.resolve(dir, pkg.svelte);
			}
		},

		/**
		 * Returns CSS contents for a file, if ours
		 */
		load(id) {
			return cache_emit.get(id) || null;
		},

		/**
		 * Transforms a `.svelte` file into a `.js` file.
		 * NOTE: If `emitCss`, append static `import` to virtual CSS file.
		 */
		async transform(code, id) {
			if (!filter(id)) return null;

			const extension = path.extname(id);
			if (!~extensions.indexOf(extension)) return null;

			const dependencies = [];
			const filename = path.relative(process.cwd(), id);
			const svelte_options = { ...compilerOptions, filename };

			if (rest.preprocess) {
				const processed = await preprocess(code, rest.preprocess, { filename });
				if (processed.dependencies) dependencies.push(...processed.dependencies);
				if (processed.map) svelte_options.sourcemap = processed.map;
				code = processed.code;
			}

			// compile subcomponents
			const sub_components = [];
			const sub_component_names = new Set();
			code = code.replace(/{#component(.*?)}(.*?){\/component}/sg, (sub_fullmatch, sub_attributes, sub_code, ...sub_restargs) => {
				const sub_name = sub_attributes.trim();
				if (sub_name.match(/[A-Z][A-Za-z0-9_]*/) == null) {
					throw 'invalid subcomponent name: '+sub_name; // TODO is this raised? use this.warn()
				}
				const sub_filename = filename.replace(/(\.svelte)$/, '__' + sub_name + '$1');
				const sub_svelte_options = { ...compilerOptions, filename: sub_filename };
				let sub_compiled;
				try {
					sub_compiled = compile(sub_code, sub_svelte_options);
					sub_components.push({ filename, sub_name, sub_filename, sub_code, sub_restargs, sub_compiled });
					sub_component_names.add(sub_name);
				} catch (compile_error) {
					// TODO handle compile error
					sub_components.push({ filename, sub_name, sub_filename, sub_code, sub_restargs, compile_error });
				}
				return ''; // TODO add empty newlines or fix sourcemaps, to keep line numbers
			});

			const compiled = compile(code, svelte_options);

			// remove warnings
			compiled.warnings = compiled.warnings.filter(w => {
				if (w.code != 'missing-declaration') return true; // keep
				// message: "'SubComponent' is not defined",
				const decl_name = (w.message.match(/^'([^']+)'/) || [])[1];
				if (sub_component_names.has(decl_name)) return false; // ignore this warning
				return true;
			});

			(compiled.warnings || []).forEach(warning => {
				if (!emitCss && warning.code === 'css-unused-selector') return;
				if (onwarn) onwarn(warning, this.warn);
				else this.warn(warning);
			});

			if (emitCss && compiled.css.code) {
				const fname = id.replace(new RegExp(`\\${extension}$`), '.css');
				compiled.js.code += `\nimport ${JSON.stringify(fname)};\n`;
				cache_emit.set(fname, compiled.css);
			}

			if (this.addWatchFile) {
				dependencies.forEach(this.addWatchFile);
			} else {
				compiled.js.dependencies = dependencies;
			}

			// inject subcomponents into compiled.js.code
			if (sub_components.length > 0) {
				const parent_imports = new Set(
					compiled.js.code
						.match(/import {(.*?)} from "svelte\/internal";\n/s)[1]
						.match(/[A-Za-z0-9_]+/g)
				);

				const parent_name = (
					s = compiled.js.code,
					a = s.lastIndexOf('export default ') + 'export default '.length,
					s.slice(a, s.indexOf(';', a))
				);

				const inject_code = sub_components.map(sc => {
					const js_code = sc.sub_compiled.js.code;
					const cut_start = js_code.indexOf('"svelte/internal";') + '"svelte/internal";'.length;
					const cut_end = js_code.lastIndexOf('export default ');
					const sc_imports = js_code.slice(0, cut_start)
						.match(/import {(.*?)} from "svelte\/internal";/s)[1]
						.match(/[A-Za-z0-9_]+/g)
						.filter(n => !parent_imports.has(n))
					;
					const import_code = (sc_imports.length == 0) ? '' : (
						'import { ' + sc_imports.join(', ') + ' } from "svelte/internal";'
					);
					const ponent_code = js_code.slice(cut_start + 1, cut_end);
					return [
						import_code,
						`${parent_name}.${sc.sub_name} = (() => {`,
						// comments must be inserted here, otherwise not visible in bundle.js
						`// subcomponent ${parent_name}.${sc.sub_name}`,
						`${ponent_code}`,
						`return ${parent_name}__${sc.sub_name};`,
						`})();`,
					].join('\n');
				}).join('\n\n');

				const idx_before_export = compiled.js.code.lastIndexOf('\nexport default ');

				compiled.js.code = (
					compiled.js.code.slice(0, idx_before_export) +
					'\n\n// inject_code:\n\n' + inject_code + '\n\n// :inject_code\n\n' +
					compiled.js.code.slice(idx_before_export + 1)
				);

				// fix subcomponent init calls
				sub_components.forEach(sc => {
					compiled.js.code = compiled.js.code.replace(
						new RegExp(`( = new )(${sc.sub_name}\\({ )`, 'g'), // TODO avoid false matches (code vs data)
						`$1${parent_name}.$2`
					);
				});

			}

			return compiled.js;
		},

		/**
		 * All resolutions done; display warnings wrt `package.json` access.
		 */
		generateBundle() {
			if (pkg_export_errors.size > 0) {
				console.warn(`\n${PREFIX} The following packages did not export their \`package.json\` file so we could not check the "svelte" field. If you had difficulties importing svelte components from a package, then please contact the author and ask them to export the package.json file.\n`);
				console.warn(Array.from(pkg_export_errors, s => `- ${s}`).join('\n') + '\n');
			}
		}
	};
};
