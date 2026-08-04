import { spawn } from 'node:child_process'

const run = (args) => spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' })
const signal = run(['run', 'signal'])
const vite = run(['run', 'dev'])
const stop = () => { signal.kill('SIGTERM'); vite.kill('SIGTERM') }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
vite.on('exit', stop)
