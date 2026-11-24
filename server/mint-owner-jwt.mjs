#!/usr/bin/env node
/**
 * Owner-run login pass command. Execution creates a credential; importing this module does not read a key.
 * Uses an existing JSON key record with the custody checks in owner-grant.mjs. No key provisioning or fallback.
 * Current access.mjs accepts at most 24h and excludes sub/iat; 72h and sub:'owner' remain unsupported.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOwnerJwtSigner, OWNER_JWT_MAX_HOURS, OWNER_KEY_FILE } from './owner-grant.mjs'
import { createAccessVerifier } from '../deploy/cloudflare/src/access.mjs'

/**
 * Run only on the owner's explicit instruction; tests inject an isolated key file and capture the token.
 * @param args - Optional --hours integer, default 24, or --help without any key access.
 * @param options - Explicit key path, clock and output callbacks. No token is written to a file or log.
 * @returns Zero on success or help; one on rejected arguments, custody failure or policy incompatibility.
 */
export async function runMintOwnerJwt(args, { keyFile, now = Date.now, stdout, stderr }) {
  if (args.length === 1 && args[0] === '--help') {
    stdout('Usage: node server/mint-owner-jwt.mjs [--hours 1..24]\nCreates a private owner login pass on stdout. Do not share or save it in logs.\n')
    return 0
  }
  const hours = args.length === 0 ? OWNER_JWT_MAX_HOURS : args.length === 2 && args[0] === '--hours' && /^(?:[1-9]|[1-9][0-9])$/.test(args[1]) ? Number(args[1]) : NaN
  if (!Number.isInteger(hours) || hours > OWNER_JWT_MAX_HOURS) {
    stderr('OWNER_JWT_INVALID_HOURS: current access policy permits 1..24 hours.\n')
    return 1
  }
  try {
    const { token, publicKeyHex } = createOwnerJwtSigner({ keyFile, now }).mint({ hours })
    const verify = createAccessVerifier({ now, fetchKeys: async () => { throw new Error('OWNER_JWT_NETWORK_FORBIDDEN') } })
    const accepted = await verify(new Request(`https://${process.env.X6_PUBLIC_HOST || 'node.example.invalid'}`, { headers: { 'x-x6-owner-assertion': token } }), { PUBLIC_HOST: process.env.X6_PUBLIC_HOST || 'node.example.invalid', OWNER_EMAIL: process.env.X6_OWNER_EMAIL || 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: publicKeyHex })
    if (!accepted || accepted.type !== 'owner') throw new Error('OWNER_JWT_POLICY_MISMATCH')
    stdout(token + '\n')
    return 0
  } catch (error) {
    stderr('OWNER_JWT_NOT_ISSUED: check the existing private key record, custody permissions and access policy.\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runMintOwnerJwt(process.argv.slice(2), {
    keyFile: OWNER_KEY_FILE,
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  })
}
