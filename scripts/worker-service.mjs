// Run the production worker as an always-on macOS launchd agent on this machine.
//   node scripts/worker-service.mjs install|restart|status|uninstall [sandbox|production]
// launchd restarts it after crashes and at login; caffeinate -i keeps the Mac from idle-sleeping while it runs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { root } from './env-files.mjs';

const [action = 'status', profile = 'production'] = process.argv.slice(2);
if (!['sandbox', 'production'].includes(profile)) throw new Error('Profile must be sandbox or production.');
const label = `com.verdant-ai.worker.${profile}`;
const plist = path.join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const log = path.join(homedir(), 'Library/Logs', `verdant-worker-${profile}.log`);
const domain = `gui/${process.getuid()}`;
const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

function install() {
  if (!existsSync(path.join(root, 'apps/worker', profile === 'sandbox' ? '.env.local' : '.env.production')))
    throw new Error(`Missing apps/worker/${profile === 'sandbox' ? '.env.local' : '.env.production'}; run pnpm env:sync.`);
  const args = ['/usr/bin/caffeinate', '-i', process.execPath, path.join(root, 'scripts/run-profile.mjs'), profile, 'worker',
    path.join(root, 'node_modules/.bin/tsx'), 'src/index.ts', '--run'];
  mkdirSync(path.dirname(plist), { recursive: true });
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${escape(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escape(path.dirname(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${escape(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escape(log)}</string>
  <key>StandardErrorPath</key><string>${escape(log)}</string>
</dict></plist>
`);
  launchctl('bootout', `${domain}/${label}`);
  const result = launchctl('bootstrap', domain, plist);
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
  console.log(`Installed ${label}. Logs: ${log}`);
}

if (action === 'install') install();
else if (action === 'restart') {
  // Pick up new worker code after a pull or deploy.
  const result = launchctl('kickstart', '-k', `${domain}/${label}`);
  if (result.status !== 0) throw new Error(`Not running; install first. ${result.stderr.trim()}`);
  console.log(`Restarted ${label}.`);
} else if (action === 'uninstall') {
  launchctl('bootout', `${domain}/${label}`);
  rmSync(plist, { force: true });
  console.log(`Removed ${label}.`);
} else if (action === 'status') {
  const result = launchctl('print', `${domain}/${label}`);
  if (result.status !== 0) { console.log(`${label} is not installed.`); process.exit(1); }
  const field = name => new RegExp(`\\n\\s*${name} = ([^\\n]+)`).exec(result.stdout)?.[1];
  console.log(JSON.stringify({ label, state: field('state'), pid: field('pid') ?? null, lastExit: field('last exit code') ?? null, log }));
  try { console.log(execFileSync('tail', ['-n', '5', log], { encoding: 'utf8' })); } catch { /* no log yet */ }
} else throw new Error('Use install, restart, status or uninstall.');
