// mend: the command-line patch tool SPEC.md (version 1) specifies.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, standard
// library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A refusal that prints exactly one line on stdout and exits 2. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order: [old path, new path]. Rolled back with the edit that made them. */
  moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Whether one line matches another at a tier (SPEC section 5). */
function lineMatches(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in the file's lines at one tier. Occurrences may overlap. */
function occurrencesAtTier(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  for (let i = 0; i + old.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineMatches(tier, old[j]!, file[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; or 0 only when strict) at which O occurs, with its positions. */
function findTier(file: string[], old: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const positions = occurrencesAtTier(file, old, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Build the replacement lines for a matched occurrence (SPEC section 5).
 * A context line is written as the file's own matched line, never the patch's.
 * At tier 2 every other line of N is re-indented: F is the leading whitespace
 * of the file's first matched line, P that of O's first line; a non-blank line
 * of N starting with P has that P replaced by F.
 */
function replacementLines(
  n: Array<{ text: string; context: boolean; oIndex: number }>,
  file: string[],
  at: number,
  old: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadingWs(file[at] ?? '') : '';
  const p = tier === 2 ? leadingWs(old[0] ?? '') : '';
  for (const line of n) {
    if (line.context) {
      out.push(file[at + line.oIndex]!);
    } else if (tier === 2 && line.text !== '' && line.text.trim() !== '' && line.text.startsWith(p)) {
      out.push(f + line.text.slice(p.length));
    } else {
      out.push(line.text);
    }
  }
  return out;
}

/** Split O/N line lists out of a hunk or chunk body, keeping each line's role. */
interface BodyLine {
  text: string;
  kind: 'context' | 'old' | 'new';
}

/** O is the context and old lines, N the context and new lines, each in body order. */
function splitBody(body: BodyLine[]): {
  o: string[];
  n: Array<{ text: string; context: boolean; oIndex: number }>;
} {
  const o: string[] = [];
  const n: Array<{ text: string; context: boolean; oIndex: number }> = [];
  for (const b of body) {
    if (b.kind === 'context') {
      const oIndex = o.length;
      o.push(b.text);
      n.push({ text: b.text, context: true, oIndex });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, context: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** SPEC section 4: detect the format, the first rule that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function requireSafe(p: string): void {
  if (!safePath(p)) throw new EditFail('unsafe', p);
}

/** Read a file from the tree as lines, or fail `missing` when it is not there. */
function readLines(tree: Tree, p: string): FileLines {
  requireSafe(p);
  const text = tree.get(p);
  if (text === null) throw new EditFail('missing', p);
  return splitFile(text);
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  noEolAfterLast: boolean;
}

interface RawSection {
  diffOld: string | null;
  diffNew: string | null;
  /** A `---`/`+++` pair was seen; hdrOldNull/hdrNewNull say a side was `/dev/null`. */
  hasHdr: boolean;
  hdrOld: string | null;
  hdrOldNull: boolean;
  hdrNew: string | null;
  hdrNewNull: boolean;
  renOld: string | null;
  renNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;

  const finishSection = (): void => {
    if (current !== null) sections.push(current);
    current = null;
    inHeader = false;
  };

  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      finishSection();
      const [x, y] = parseDiffGit(line, lineNo);
      current = {
        diffOld: x,
        diffNew: y,
        hasHdr: false,
        hdrOld: null,
        hdrOldNull: false,
        hdrNew: null,
        hdrNewNull: false,
        renOld: null,
        renNew: null,
        creation: false,
        deletion: false,
        hunks: [],
      };
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current === null || !inHeader) {
        finishSection();
        current = {
          diffOld: null,
          diffNew: null,
          hasHdr: false,
          hdrOld: null,
          hdrOldNull: false,
          hdrNew: null,
          hdrNewNull: false,
          renOld: null,
          renNew: null,
          creation: false,
          deletion: false,
          hunks: [],
        };
        inHeader = true;
      }
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      current.hasHdr = true;
      current.hdrOldNull = oldP === '/dev/null';
      current.hdrNewNull = newP === '/dev/null';
      current.hdrOld = current.hdrOldNull ? null : stripAB(oldP);
      current.hdrNew = current.hdrNewNull ? null : stripAB(newP);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      inHeader = false;
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      // The body index a `\` line followed, or -1 when none has been seen.
      let slashAfter = -1;
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(bl)) break;
        if (bl === '') {
          body.push({ text: '', kind: 'context' });
        } else if (bl[0] === ' ') {
          body.push({ text: bl.slice(1), kind: 'context' });
        } else if (bl[0] === '-') {
          body.push({ text: bl.slice(1), kind: 'old' });
        } else if (bl[0] === '+') {
          body.push({ text: bl.slice(1), kind: 'new' });
        } else {
          // A `\` line refers to the body line before it.
          if (body.length > 0) slashAfter = body.length - 1;
        }
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.kind === 'context' && body[body.length - 1]!.text === '') {
        body.pop();
      }
      const noEolAfterLast =
        slashAfter >= 0 && slashAfter === body.length - 1 && body[slashAfter]!.kind !== 'old';
      current.hunks.push({ a, body, noEolAfterLast });
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // A `--- ` line not followed by a `+++ ` line, inside a section's header.
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      if (line.startsWith('rename from ')) {
        if (current.renOld === null) current.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (current.renNew === null) current.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.creation = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.deletion = true;
        i += 1;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  finishSection();

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

/** Apply one hunk to a file's lines; returns the new lines and final-break flag. */
function applyHunk(
  f: FileLines,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; finalBreak: boolean } {
  const { o, n } = splitBody(hunk.body);
  const file = f.lines;
  if (o.length === 0) {
    const at = Math.min(hunk.a + d, file.length);
    const repl = n.map((x) => x.text);
    const lines = [...file.slice(0, at), ...repl, ...file.slice(at)];
    const atEnd = at === file.length;
    const finalBreak = atEnd ? !hunk.noEolAfterLast : f.finalBreak;
    return { lines, finalBreak };
  }
  const found = findTier(file, o, strict);
  if (found === null) throw new EditFail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const pos of found.positions) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const repl = replacementLines(n, file, best, o, found.tier);
  const lines = [...file.slice(0, best), ...repl, ...file.slice(best + o.length)];
  const toEnd = best + o.length === file.length;
  const finalBreak = toEnd ? !hunk.noEolAfterLast : f.finalBreak;
  return { lines, finalBreak };
}

function makeUnifiedEdit(section: RawSection, strict: boolean): Edit {
  // Path order: the `---`/`+++` pair, then `rename from`/`rename to`, then the `diff --git` paths.
  // A side that was `/dev/null` names no file.
  const oldPath = section.hasHdr
    ? section.hdrOldNull
      ? null
      : section.hdrOld
    : (section.renOld ?? section.diffOld);
  const newPath = section.hasHdr
    ? section.hdrNewNull
      ? null
      : section.hdrNew
    : (section.renNew ?? section.diffNew);
  const creation = section.creation || (section.hasHdr && section.hdrOldNull);
  const deletion = !creation && (section.deletion || (section.hasHdr && section.hdrNewNull));
  return (tree) => {
    applyUnifiedSection(tree, section, oldPath, newPath, creation, deletion, strict);
  };
}

function applyUnifiedSection(
  tree: Tree,
  section: RawSection,
  oldPath: string | null,
  newPath: string | null,
  creation: boolean,
  deletion: boolean,
  strict: boolean,
): void {
  if (creation) {
    if (newPath === null) throw new EditFail('unsafe', '');
    const p = newPath;
    requireSafe(p);
    if (tree.get(p) !== null) throw new EditFail('exists', p);
    // The file is the `+` lines of all its hunks, in order.
    const plus: string[] = [];
    for (const h of section.hunks) {
      for (const b of h.body) {
        if (b.kind === 'new') plus.push(b.text);
      }
    }
    if (plus.length === 0) {
      tree.set(p, '');
      return;
    }
    // A created file ends with a line break unless a `\` line follows its last `+` line:
    // look at the last hunk that carries a `+` line, and whether its last body line is
    // that `+` line with a `\` line after it.
    let endsWithBreak = true;
    for (let hi = section.hunks.length - 1; hi >= 0; hi -= 1) {
      const h = section.hunks[hi]!;
      let lastPlus = -1;
      for (let bi = 0; bi < h.body.length; bi += 1) {
        if (h.body[bi]!.kind === 'new') lastPlus = bi;
      }
      if (lastPlus >= 0) {
        endsWithBreak = !(h.noEolAfterLast && lastPlus === h.body.length - 1);
        break;
      }
    }
    tree.set(p, plus.join('\n') + (endsWithBreak ? '\n' : ''));
    return;
  }
  if (deletion) {
    if (oldPath === null) throw new EditFail('unsafe', '');
    const p = oldPath;
    requireSafe(p);
    if (tree.get(p) === null) throw new EditFail('missing', p);
    tree.set(p, null);
    return;
  }
  const move = oldPath !== newPath;
  if (move) {
    const from = oldPath!;
    const to = newPath!;
    requireSafe(from);
    requireSafe(to);
    const text = tree.get(from);
    if (text === null) throw new EditFail('missing', from);
    if (tree.get(to) !== null) throw new EditFail('exists', to);
    let f = splitFile(text);
    let d = 0;
    for (const h of section.hunks) {
      const { o, n } = splitBody(h.body);
      const r = applyHunk(f, h, d, strict, from);
      f = { lines: r.lines, br: f.br, finalBreak: r.finalBreak };
      d += n.length - o.length;
    }
    tree.set(from, null);
    tree.set(to, joinFile(f));
    tree.moves.push([from, to]);
    return;
  }
  // A change of the one path.
  const p = oldPath!;
  requireSafe(p);
  const text = tree.get(p);
  if (text === null) throw new EditFail('missing', p);
  let f = splitFile(text);
  let d = 0;
  for (const h of section.hunks) {
    const { o, n } = splitBody(h.body);
    const r = applyHunk(f, h, d, strict, p);
    f = { lines: r.lines, br: f.br, finalBreak: r.finalBreak };
    d += n.length - o.length;
  }
  tree.set(p, joinFile(f));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line (or the start of the patch), that is not blank and
    // does not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // Find the `=======` and then the `>>>>>>> REPLACE` after the SEARCH line.
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < n; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    requireSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const f = readLines(tree, path);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.positions.length > 1) throw new EditFail('ambiguous', path);
    const at = found.positions[0]!;
    const repl = replacementLines(
      newLines.map((t) => ({ text: t, context: false, oIndex: -1 })),
      f.lines,
      at,
      oldLines,
      found.tier,
    );
    const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.set(path, joinFile({ lines, br: f.br, finalBreak: f.finalBreak }));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  lineNo: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const sections: V4aSection[] = [];
  let current: V4aSection | null = null;
  let currentChunk: V4aChunk | null = null;

  const finishChunk = (): void => {
    if (current !== null && currentChunk !== null) {
      current.chunks.push(currentChunk);
      currentChunk = null;
    }
  };
  const finishSection = (): void => {
    if (current === null) return;
    finishChunk();
    // Blank lines at the end of a section are not part of it.
    if (current.kind === 'add') {
      while (current.lines.length > 0 && current.lines[current.lines.length - 1] === '') current.lines.pop();
    }
    if (current.kind === 'update') {
      for (const c of current.chunks) {
        while (
          c.body.length > 0 &&
          c.body[c.body.length - 1]!.kind === 'context' &&
          c.body[c.body.length - 1]!.text === ''
        ) {
          c.body.pop();
        }
      }
    }
    sections.push(current);
    current = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      finishSection();
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(': ') + 2).trim();
      current = { kind, path, moveTo: null, lines: [], chunks: [], lineNo };
      currentChunk = null;
      continue;
    }
    if (current === null) {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (current.kind === 'add') {
      if (line.startsWith('+')) current.lines.push(line.slice(1));
      else if (line === '') current.lines.push('');
      else throw new Exit2(`error: parse ${lineNo}`);
      continue;
    }
    if (current.kind === 'delete') {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }
    // Update File section.
    if (line.trim() === '*** End of File') {
      if (currentChunk === null) {
        // An `*** End of File` with no chunk open starts an empty end-of-file chunk.
        currentChunk = { anchor: null, body: [], eof: true };
      } else {
        currentChunk.eof = true;
      }
      finishChunk();
      continue;
    }
    if (line.startsWith('*** Move to: ') && current.chunks.length === 0 && currentChunk === null && current.moveTo === null) {
      current.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      finishChunk();
      currentChunk = { anchor: line.slice(2).trim(), body: [], eof: false };
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (currentChunk === null) {
        currentChunk = { anchor: null, body: [], eof: false };
      }
      if (line === '') currentChunk.body.push({ text: '', kind: 'context' });
      else if (line[0] === ' ') currentChunk.body.push({ text: line.slice(1), kind: 'context' });
      else if (line[0] === '-') currentChunk.body.push({ text: line.slice(1), kind: 'old' });
      else currentChunk.body.push({ text: line.slice(1), kind: 'new' });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  finishSection();

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeV4aEdit(s, strict));
}

function singleLineTier(file: string[], anchor: string, from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    for (let i = from; i < file.length; i += 1) {
      if (lineMatches(tier, anchor, file[i]!)) return i;
    }
  }
  return null;
}

function makeV4aEdit(section: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = section.path;
    requireSafe(p);
    if (section.kind === 'add') {
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, section.lines.length === 0 ? '' : section.lines.join('\n') + '\n');
      return;
    }
    if (section.kind === 'delete') {
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.set(p, null);
      return;
    }
    // Update File.
    if (section.moveTo !== null) requireSafe(section.moveTo);
    if (section.chunks.length === 0 && section.moveTo === null) {
      throw new Exit2(`error: parse ${section.lineNo}`);
    }
    const text = tree.get(p);
    if (text === null) throw new EditFail('missing', p);
    if (section.moveTo !== null && tree.get(section.moveTo) !== null) throw new EditFail('exists', section.moveTo);
    let f = splitFile(text);
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = singleLineTier(f.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new EditFail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const repl = n.map((x) => x.text);
        f = {
          lines: [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at)],
          br: f.br,
          finalBreak: f.finalBreak,
        };
        cursor = at + repl.length;
        continue;
      }
      // First occurrence of O at or after the cursor, at the first tier with one.
      const maxTier = strict ? 0 : 2;
      let placed: { tier: number; pos: number } | null = null;
      for (let tier = 0; tier <= maxTier && placed === null; tier += 1) {
        for (const pos of occurrencesAtTier(f.lines, o, tier)) {
          if (pos < cursor) continue;
          if (chunk.eof && pos + o.length !== f.lines.length) continue;
          placed = { tier, pos };
          break;
        }
      }
      if (placed === null) throw new EditFail('no-match', p);
      const repl = replacementLines(n, f.lines, placed.pos, o, placed.tier);
      f = {
        lines: [...f.lines.slice(0, placed.pos), ...repl, ...f.lines.slice(placed.pos + o.length)],
        br: f.br,
        finalBreak: f.finalBreak,
      };
      cursor = placed.pos + repl.length;
    }
    if (section.moveTo !== null) {
      tree.set(p, null);
      tree.set(section.moveTo, joinFile(f));
      tree.moves.push([p, section.moveTo]);
    } else {
      tree.set(p, joinFile(f));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      // A JSON `create` writes its `file_text` byte for byte.
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      requireSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      requireSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new EditFail('no-match', p);
      const lines = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.set(p, joinFile({ lines, br: f.br, finalBreak: f.finalBreak }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity       */
/* ------------------------------------------------------------------ */

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  // Section 1: parse the command line.
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;

  // Read the patch: from the file, or from standard input.
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  // Parse the patch into edits. A patch with no edit at all is `error: parse 1`.
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  // Section 10: edits apply in order to the tree as earlier edits left it.
  // A failed edit changes nothing, and the edits after it still run.
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Section 2: one line for each path whose state changed, in byte order of the paths.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [from, to] of tree.moves) {
    const fromChange = changed.get(from);
    const toChange = changed.get(to);
    if (
      fromChange !== undefined &&
      toChange !== undefined &&
      fromChange.was !== null &&
      fromChange.now === null &&
      toChange.was === null &&
      toChange.now !== null
    ) {
      // A move replaces that pair's `D` and `A` lines and sorts by `<new>`.
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      changed.delete(from);
      changed.delete(to);
    }
  }
  for (const [p, c] of changed) {
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
