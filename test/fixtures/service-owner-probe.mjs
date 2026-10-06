// An isolated worker used to verify cleanup on abrupt owner death, never a daemon.
import { VerificationServices } from '../../src/core/verification-services.ts';

process.env.FACTORY_TRUSTED_EXECUTION = '1';
const context = { repo: { workdir: process.cwd() }, commandTimeoutMs: 10_000,
  logger: { info() {}, warn() {}, error() {}, child() { return this; } } };
const services = new VerificationServices(context, () => {});
const application = "require('node:http').createServer((request,response)=>response.end('owned')).listen(Number(process.argv[1]),'127.0.0.1');";
const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(application)},process.argv[1]],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
const result = await services.tools()[0].execute({ program: 'node', args: ['-e', launcher, '{port}'], url: 'http://127.0.0.1:0' }, context);
console.log(JSON.stringify({ ...result, supervisorPid: [...services.services.values()][0]?.child.pid }));
if (!result.passed) { await services.close(); process.exit(1); }
