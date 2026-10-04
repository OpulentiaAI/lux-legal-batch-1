import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'

const blocked = () => { throw new Error('OFFLINE_ONLY: no inference, provider API or VM creation') }
globalThis.fetch = blocked
http.request = http.get = https.request = https.get = net.connect = net.createConnection = blocked
syncBuiltinESMExports()
