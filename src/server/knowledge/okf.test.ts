import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  baseName,
  conformance,
  hasFrontMatter,
  indexLine,
  isConceptPath,
  isReserved,
  logWith,
  OKF_VERSION,
  readConcept,
  renderConcept,
  renderIndex,
  rootIndexProblem,
  textField,
  trustTier,
} from './okf'

describe('the files of an OKF bundle', () => {
  it('reserves index.md and log.md at every level, and nothing else', () => {
    expect(isReserved('index.md')).toBe(true)
    expect(isReserved('a/b/log.md')).toBe(true)
    expect(isReserved('a/my-index.md')).toBe(false)
    expect(isReserved('index.md/x.md')).toBe(false)
  })

  it('takes every other markdown file as a concept', () => {
    expect(isConceptPath('knowledge/a.md')).toBe(true)
    expect(isConceptPath('README.MD')).toBe(true)
    expect(isConceptPath('knowledge/index.md')).toBe(false)
    expect(isConceptPath('a.md.txt')).toBe(false)
    expect(isConceptPath('a.json')).toBe(false)
  })

  it('names a file by the last part of its path', () => {
    expect(baseName('a/b/c.md')).toBe('c.md')
    expect(baseName('c.md')).toBe('c.md')
  })
})

describe('a concept document', () => {
  it('is its YAML front matter and the body after it', () => {
    expect(readConcept('---\ntype: Rule\ntags: [a, b]\n---\n# Body\n')).toEqual({
      frontmatter: { type: 'Rule', tags: ['a', 'b'] },
      body: '# Body\n',
    })
  })

  it('reads a block with Windows line ends and one that ends the file', () => {
    expect(readConcept('---\r\ntype: Rule\r\n---\r\nbody').frontmatter).toEqual({ type: 'Rule' })
    expect(readConcept('---\ntype: Rule\n---')).toEqual({ frontmatter: { type: 'Rule' }, body: '' })
  })

  it('keeps timestamps as the text they were written in', () => {
    const { frontmatter } = readConcept(
      '---\ntype: X\ngenerated: { by: a/1, at: 2026-06-20T22:53:05Z }\n---\n',
    )
    expect(frontmatter?.generated).toEqual({ by: 'a/1', at: '2026-06-20T22:53:05Z' })
  })

  it('says it has no front matter when the text does not start with a closed block', () => {
    expect(readConcept('# Title\n')).toEqual({ body: '# Title\n', problem: 'has no front matter' })
    expect(readConcept('---\ntype: Rule\n').problem).toBe('has no front matter')
    expect(readConcept(' ---\ntype: Rule\n---\n').problem).toBe('has no front matter')
  })

  it('says its front matter is not YAML, with what the parser said', () => {
    const concept = readConcept('---\ntype: [Rule\n---\nbody')
    expect(concept.frontmatter).toBeUndefined()
    expect(concept.body).toBe('body')
    let said = ''
    try {
      parse('type: [Rule')
    } catch (error) {
      said = (error as Error).message.split('\n')[0]
    }
    expect(said.length).toBeGreaterThan(5)
    expect(concept.problem).toBe(`has front matter that is not YAML (${said})`)
    expect(concept.problem).not.toContain('\n')
  })

  it('says its front matter is not a mapping when it is a list, a word or empty', () => {
    for (const yaml of ['- a', 'word', '~']) {
      expect(readConcept(`---\n${yaml}\n---\n`).problem, yaml).toBe(
        'has front matter that is not a mapping',
      )
    }
  })

  it('says it has no type when the key is missing, empty or not text', () => {
    for (const yaml of ['title: x', 'type: ""', 'type: "  "', 'type: 3']) {
      const concept = readConcept(`---\n${yaml}\n---\n`)
      expect(concept.problem, yaml).toBe('has no type in its front matter')
      expect(concept.frontmatter, yaml).toBeDefined()
    }
  })

  it('tells a closed block from text', () => {
    expect(hasFrontMatter('---\na: 1\n---\n')).toBe(true)
    expect(hasFrontMatter('---\na: 1\n')).toBe(false)
  })

  it('gives a value as text only when it is a string or a number', () => {
    const fm = { a: 'x', b: 0.2, c: true, d: { e: 1 } }
    expect(textField(fm, 'a')).toBe('x')
    expect(textField(fm, 'b')).toBe('0.2')
    expect(textField(fm, 'c')).toBeUndefined()
    expect(textField(fm, 'd')).toBeUndefined()
    expect(textField(fm, 'z')).toBeUndefined()
    expect(textField(undefined, 'a')).toBeUndefined()
  })

  it('keeps a long value on one line', () => {
    const title = 'word '.repeat(40).trim()
    expect(renderConcept({ type: 'Rule', title }, 'x')).toContain(`\ntitle: ${title}\n`)
  })

  it('is written with its front matter as YAML and the body trimmed', () => {
    const text = renderConcept({ type: 'Rule', title: 'a: b\n---\ntype: x' }, '\n  body  \n')
    expect(text.startsWith('---\ntype: Rule\n')).toBe(true)
    expect(text.endsWith('---\n\nbody\n')).toBe(true)
    expect(readConcept(text)).toEqual({
      frontmatter: { type: 'Rule', title: 'a: b\n---\ntype: x' },
      body: '\nbody\n',
    })
  })
})

describe('the root index of a bundle', () => {
  it('declares the version the factory writes', () => {
    expect(rootIndexProblem(`---\nokf_version: "${OKF_VERSION}"\n---\n`)).toBeUndefined()
    expect(rootIndexProblem('---\nokf_version: 0.2\n---\n')).toBeUndefined()
  })

  it('says what is wrong with it otherwise', () => {
    expect(rootIndexProblem(undefined)).toBe('index.md is missing at the root')
    expect(rootIndexProblem('# Index\n')).toBe('index.md at the root does not say okf_version')
    expect(rootIndexProblem('---\ntitle: x\n---\n')).toBe(
      'index.md at the root does not say okf_version',
    )
    expect(rootIndexProblem('---\nokf_version: "0.1"\n---\n')).toBe(
      'index.md at the root says okf_version 0.1; the factory writes 0.2',
    )
    expect(rootIndexProblem('---\nokf_version: [\n---\n')).toMatch(
      /^index\.md at the root has front matter that is not YAML/,
    )
  })
})

describe('the conformance of a bundle', () => {
  it('names the root index first, then each concept that does not conform, in order', () => {
    expect(
      conformance(undefined, [
        { path: 'b.md', text: 'no front matter' },
        { path: 'index.md', text: 'no front matter either' },
        { path: 'a/log.md', text: 'a log' },
        { path: 'a.json', text: '{}' },
        { path: 'ok.md', text: '---\ntype: Rule\n---\n' },
        { path: 'a.md', text: '---\ntitle: x\n---\n' },
      ]),
    ).toEqual([
      'index.md is missing at the root',
      'b.md has no front matter',
      'a.md has no type in its front matter',
    ])
  })

  it('is nothing to say for a bundle that conforms', () => {
    expect(
      conformance('---\nokf_version: "0.2"\n---\n', [
        { path: 'a.md', text: '---\ntype: X\n---\n' },
      ]),
    ).toEqual([])
  })
})

describe('the trust tier of a concept', () => {
  it('is unverified without a verification by an actor', () => {
    expect(trustTier(undefined)).toBe('unverified')
    expect(trustTier({ type: 'X' })).toBe('unverified')
    expect(trustTier({ verified: [] })).toBe('unverified')
    expect(trustTier({ verified: [null, { at: 'x' }, { by: 3 }] })).toBe('unverified')
  })

  it('is machine-confirmed when only processes and agents verified it', () => {
    expect(trustTier({ verified: [{ by: 'process:nightly' }, { by: 'agent/1' }] })).toBe(
      'machine-confirmed',
    )
  })

  it('is human-reviewed once a person verified it, a single mapping counting as a list of one', () => {
    expect(trustTier({ verified: { by: 'human:ana' } })).toBe('human-reviewed')
    expect(trustTier({ verified: [{ by: 'process:x' }, { by: 'human:ana' }] })).toBe(
      'human-reviewed',
    )
    expect(trustTier({ verified: { by: 'ana:human' } })).toBe('machine-confirmed')
  })
})

describe('an index file', () => {
  it('lists a concept as a link with its description', () => {
    expect(indexLine({ title: 'Orders', href: 'tables/orders.md', description: 'One row.' })).toBe(
      '* [Orders](tables/orders.md) - One row.',
    )
  })

  it('keeps a title, a path and a description from breaking the line', () => {
    expect(
      indexLine({ title: 'a [b]\\c\n d', href: 'my notes/a.md', description: 'one\n  two ' }),
    ).toBe('* [a \\[b\\]\\\\c d](my%20notes/a.md) - one two')
  })

  it('leaves the description out when there is none, or it is blank', () => {
    expect(indexLine({ title: 'A', href: 'a.md' })).toBe('* [A](a.md)')
    expect(indexLine({ title: 'A', href: 'a.md', description: '  \n ' })).toBe('* [A](a.md)')
  })

  it('has sections of links, with the version in front matter only at the root of a bundle', () => {
    const sections = [
      { heading: 'Tables', entries: [{ title: 'A', href: 'a.md' }] },
      { heading: 'Empty\nheading', entries: [] },
    ]
    expect(renderIndex(sections)).toBe('# Tables\n\n* [A](a.md)\n\n# Empty heading\n')
    expect(renderIndex(sections, { root: true })).toBe(
      '---\nokf_version: "0.2"\n---\n\n# Tables\n\n* [A](a.md)\n\n# Empty heading\n',
    )
    expect(renderIndex([])).toBe('\n')
  })
})

describe('a log file', () => {
  it('starts with its title and the day', () => {
    expect(logWith(undefined, 'Log\nof a', '2026-11-07', ['**Creation**: a', 'b\n c'])).toBe(
      '# Log of a\n\n## 2026-11-07\n* **Creation**: a\n* b c\n',
    )
  })

  it('adds to the top of the day that is already there', () => {
    const log = '# Log\n\n## 2026-11-07\n* old\n\n## 2026-11-01\n* older\n'
    expect(logWith(log, 'ignored', '2026-11-07', ['new'])).toBe(
      '# Log\n\n## 2026-11-07\n* new\n* old\n\n## 2026-11-01\n* older\n',
    )
  })

  it('puts a new day above the older ones', () => {
    const log = '# Log\n\n## 2026-11-01\n* older\n\n\n'
    expect(logWith(log, 'ignored', '2026-11-07', ['new'])).toBe(
      '# Log\n\n## 2026-11-07\n* new\n\n## 2026-11-01\n* older\n',
    )
  })

  it('adds the day at the end of a log that has none yet', () => {
    expect(logWith('# Log\nwritten by hand', 'ignored', '2026-11-07', ['new'])).toBe(
      '# Log\nwritten by hand\n\n## 2026-11-07\n* new\n',
    )
  })
})
