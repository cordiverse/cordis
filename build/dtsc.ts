import spawn from 'cross-spawn'
import globby from 'globby'
import fs from 'fs-extra'
import json5 from 'json5'
import { EOL } from 'os'
import { resolve } from 'path'

const cwd = process.cwd()
const args = process.argv.slice(2)

export function spawnAsync(args: string[]) {
  const child = spawn(args[0], args.slice(1), { cwd, stdio: 'inherit' })
  return new Promise<number>((resolve) => {
    child.on('close', resolve)
  })
}

async function compile(filename: string) {
  const code = await spawnAsync(['tsc', '-b', ...args])
  if (code) process.exit(code)
  return fs.readFile(filename, 'utf8')
}

async function getModules(srcpath: string) {
  const files = await globby(srcpath)
  return files.map(file => file.slice(srcpath.length + 1, -3))
}

async function bundle() {
  const config = json5.parse(fs.readFileSync(resolve(cwd, 'tsconfig.json'), 'utf8'))
  const { outFile, rootDir } = config.compilerOptions

  const srcpath = `${cwd.replace(/\\/g, '/')}/${rootDir}`
  const [files, content] = await Promise.all([
    getModules(srcpath),
    compile(resolve(cwd, outFile)),
  ])

  const moduleRE = `["'](${files.join('|')})["']`
  const internalImport = new RegExp('import\\(' + moduleRE + '\\)\\.', 'g')
  const internalExport = new RegExp('^ {4}export .+ from ' + moduleRE + ';$')
  const internalInject = new RegExp('^declare module ' + moduleRE + ' {$')
  const importMap: Record<string, Record<string, string>> = {}
  const namespaceMap: Record<string, string> = {}

  let prolog = '', cap: RegExpExecArray
  let current: string, temporary: string[]
  let identifier: string, isExportDefault: boolean
  const platforms: Record<string, Record<string, string[]>> = {}
  const output = content.split(EOL).filter((line) => {
    // Step 1: collect informations
    if (isExportDefault) {
      if (line === '    }') isExportDefault = false
      return false
    } else if (temporary) {
      if (line === '}') return temporary = null
      temporary.push(line)
    } else if (cap = /^declare module ["'](.+)["'] \{( \})?$/.exec(line)) {
      //                                  ^1
      // ignore empty module declarations
      if (cap[2]) return temporary = null
      current = cap[1]
      const segments = current.split(/\//g)
      const lastName = segments.pop()
      if (['node', 'browser'].includes(lastName) && segments.length) {
        temporary = (platforms[segments.join('/')] ||= {})[lastName] = []
      } else {
        return true
      }
    } else if (cap = /^ {4}import ["'](.+)["'];$/.exec(line)) {
      //                       ^1
      // import module directly
      if (!files.includes(cap[1])) prolog += line.trimStart() + EOL
    } else if (cap = /^ {4}import \* as (.+) from ["'](.+)["'];$/.exec(line)) {
      //                                ^1            ^2
      // import as namespace
      if (files.includes(cap[2])) {
        // mark internal module as namespace
        namespaceMap[cap[2]] = cap[1]
      } else if (!prolog.includes(line.trimStart())) {
        // preserve external module imports once
        prolog += line.trimStart() + EOL
      }
    } else if (cap = /^ {4}import (\S*)(?:, *)?(?:\{(.+)\})? from ["'](.+)["'];$/.exec(line)) {
      //                          ^1                ^2                ^3
      // ignore internal imports
      if (files.includes(cap[3])) return
      // handle aliases from external imports
      const map = importMap[cap[3]] ||= {}
      cap[1] && Object.defineProperty(map, 'default', { value: cap[1] })
      cap[2] && cap[2].split(',').map((part) => {
        part = part.trim()
        if (part.includes(' as ')) {
          const [left, right] = part.split(' as ')
          map[left.trimEnd()] = right.trimStart()
        } else {
          map[part] = part
        }
      })
    } else if (line.startsWith('///')) {
      prolog += line + EOL
    } else if (line.startsWith('    export default ')) {
      if (current === 'index') return true
      if (line.endsWith('{')) isExportDefault = true
      return false
    } else {
      return line.trim() !== 'export {};'
    }
  }).map((line) => {
    // Step 2: flatten module declarations
    if (cap = /^declare module ["'](.+)["'] \{$/.exec(line)) {
      if (identifier = namespaceMap[cap[1]]) {
        return `declare namespace ${identifier} {`
      } else {
        return ''
      }
    } else if (line === '}') {
      return identifier ? '}' : ''
    } else if (!internalExport.exec(line)) {
      if (!identifier) line = line.slice(4)
      return line
        .replace(internalImport, '')
        .replace(/import\("index"\)/g, "import('.')")
        .replace(/^(module|class|namespace|const) /, (_) => `declare ${_}`)
    } else {
      return ''
    }
  }).map((line) => {
    if (cap = internalInject.exec(line)) {
      identifier = '@internal'
      return ''
    } else if (line === '}') {
      return identifier ? identifier = '' : '}'
    } else {
      if (identifier) line = line.slice(4)
      return line.replace(/^((class|namespace|interface) .+ \{)$/, (_) => `export ${_}`)
    }
  }).filter(line => line).join(EOL)

  Object.entries(importMap).forEach(([name, map]) => {
    const output: string[] = []
    const entries = Object.entries(map)
    if (map.default) output.push(map.default)
    if (entries.length) {
      output.push('{ ' + entries.map(([left, right]) => {
        if (left === right) return left
        return `${left} as ${right}`
      }).join(', ') + ' }')
    }
    prolog += `import ${output.join(', ')} from '${name}';${EOL}`
  })

  return fs.writeFile(resolve(cwd, 'lib/index.d.ts'), prolog + output + EOL)
}

bundle()
