import { execFile, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../YotoPodcast.app');
const MAIN_SCPT = join(APP_DIR, 'Contents/Resources/Scripts/main.scpt');
const APPLET = join(APP_DIR, 'Contents/MacOS/applet');

export function notify(title: string, message: string): void {
  try {
    // Escape double quotes for AppleScript
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMsg = message.replace(/"/g, '\\"');
    execFileSync('osacompile', [
      '-o', MAIN_SCPT,
      '-e', `display notification "${safeMsg}" with title "${safeTitle}"`,
    ]);
    execFile(APPLET, (err) => {
      if (err) { /* silently ignore */ }
    });
  } catch {
    // Fall back to plain notification
    execFile('osascript', [
      '-e',
      `display notification "${message}" with title "${title}"`,
    ], () => { /* silently ignore */ });
  }
}
