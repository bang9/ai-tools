import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConnectURL, parseConnectURL } from '../src/api/client.ts'

test('buildConnectURL uses a fragment token', () => {
  assert.equal(buildConnectURL('https://public.example', 'abc123'), 'https://public.example#token=abc123')
})

test('parseConnectURL accepts fragment-style connect URLs', () => {
  assert.deepEqual(parseConnectURL('https://public.example#token=abc123'), {
    baseURL: 'https://public.example/',
    token: 'abc123',
  })
})

test('parseConnectURL accepts dashboard URLs that carry a fragment-style connect URL', () => {
  assert.deepEqual(parseConnectURL('https://whip.bang9.dev#https://public.example#token=abc123'), {
    baseURL: 'https://public.example/',
    token: 'abc123',
  })
})

test('parseConnectURL keeps legacy query-token URLs working', () => {
  assert.deepEqual(parseConnectURL('https://public.example?token=abc123'), {
    baseURL: 'https://public.example/',
    token: 'abc123',
  })
})
