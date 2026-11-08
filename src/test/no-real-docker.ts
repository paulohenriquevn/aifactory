import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Puts a `docker` first on the PATH that refuses to run. The unit and integration suites script Docker
 * through the provider's `docker` parameter; a test that falls back to the real one, or a mutant that
 * makes the code do so, would otherwise start real containers on this machine, or remove real ones, and
 * leave them behind when the test is cut short. The end-to-end suite, which means to run Docker, does not
 * load this file.
 */
const bin = mkdtempSync(join(tmpdir(), 'no-real-docker-'))
writeFileSync(
  join(bin, 'docker'),
  '#!/bin/sh\necho "the unit and integration suites never run the real docker: a test reached it" >&2\nexit 97\n',
)
chmodSync(join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
