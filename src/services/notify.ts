import { execFile, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../YotoPodcast.app');
const MAIN_SCPT = join(APP_DIR, 'Contents/Resources/Scripts/main.scpt');
const APPLET = join(APP_DIR, 'Contents/MacOS/applet');

// A quoted AppleScript string literal. Titles come from podcast feeds, so a stray
// backslash or quote must not end the string and let the rest run as script.
export function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function notify(title: string, message: string): void {
  const script = `display notification ${appleString(message)} with title ${appleString(title)}`;
  try {
    execFileSync('osacompile', ['-o', MAIN_SCPT, '-e', script]);
    execFile(APPLET, (err) => {
      if (err) { /* silently ignore */ }
    });
  } catch {
    // Fall back to plain notification
    execFile('osascript', ['-e', script], () => { /* silently ignore */ });
  }
}
