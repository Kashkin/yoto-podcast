#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadConfig, yotoLibrary } from './config.js';
import { prepareAlbum, printReport } from './commands/prepare.js';
import { runAuth, getValidTokens } from './commands/auth.js';
import type { StoredTokens } from './types.js';
import { runCheck } from './commands/check.js';
import { runBackfill } from './commands/backfill.js';
import { runFixFormats } from './commands/fix-formats.js';
import { createYotoService } from './services/yoto.js';
import { notify } from './services/notify.js';
import * as myo from './commands/myo.js';
import * as labelsCmd from './commands/labels.js';

const CONFIG_DIR = join(homedir(), '.config', 'yoto-podcast');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const TOKENS_PATH = join(CONFIG_DIR, 'tokens.json');

const program = new Command();
program.name('yoto-podcast').version('0.1.0');

program
  .command('auth')
  .description('Authenticate with Yoto (device code flow)')
  .action(async () => {
    await runAuth(CONFIG_PATH, TOKENS_PATH);
  });

program
  .command('check')
  .description('Check all feeds for new episodes, download, and push to Yoto')
  .option('--force', 'Download and push even when more than 5 episodes are new', false)
  .action(async (options) => {
    try {
      console.log(`\n--- yoto-podcast check @ ${new Date().toLocaleString()} ---`);
      const config = loadConfig(CONFIG_PATH);

      // A failed token refresh must not abort the run —
      // episodes still download to disk and can be backfilled to Yoto later.
      let tokens: StoredTokens | null = null;
      try {
        tokens = await getValidTokens(CONFIG_PATH, TOKENS_PATH);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        console.error('Continuing with downloads only. Run `yoto-podcast auth` to fix.');
        notify('Yoto Podcast', 'Yoto auth failed - downloading only. Run: yoto-podcast auth');
      }

      const yoto = tokens ? createYotoService(tokens.accessToken) : null;

      const results = await runCheck(config, yoto, { force: options.force });
      const totalNew = results.reduce((n, r) => n + r.downloaded.length, 0);

      console.log(`\nDone. ${totalNew} new episode(s) downloaded.`);
      if (!yoto && totalNew > 0) {
        console.log('Not pushed to Yoto (no valid token). Files are on disk; the next run after `yoto-podcast auth` pushes them.');
      }
      // So `launchctl list` shows a run that needs attention
      if (!yoto || results.some((r) => r.errors.length > 0)) process.exitCode = 1;
    } catch (err) {
      // Any fatal error here previously died silently into the launchd log.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Check failed: ${msg}`);
      notify('Yoto Podcast', `Check failed: ${msg}`);
      process.exitCode = 1;
    }
  });

program
  .command('fix-formats')
  .description('Detect actual codec of each chapter and patch the format label to match')
  .option('--dry-run', 'Show changes without writing', false)
  .action(async (options) => {
    const config = loadConfig(CONFIG_PATH);
    const tokens = await getValidTokens(CONFIG_PATH, TOKENS_PATH);
    if (!tokens) {
      console.error('No Yoto tokens found. Run `yoto-podcast auth` first.');
      process.exit(1);
    }
    await runFixFormats(config, tokens.accessToken, { dryRun: options.dryRun });
  });

program
  .command('backfill')
  .description('Download full catalog of a podcast')
  .requiredOption('--feed <url>', 'RSS feed URL')
  .requiredOption('--dir <path>', 'Download directory')
  .requiredOption('--name <name>', 'Podcast name')
  .option('--card <cardId>', 'Yoto card ID')
  .option('--limit <n>', 'Only the newest n episodes', (v) => {
    if (!/^[1-9]\d*$/.test(v)) throw new InvalidArgumentError('It must be a whole number above 0.');
    return Number(v);
  })
  .option('--skip <patterns...>', 'Leave out episodes whose title contains any of these (like skipPatterns)')
  .option('--dry-run', 'Show what would download and go on the card without writing', false)
  .action(async (options) => {
    await runBackfill(options, { configPath: CONFIG_PATH, tokensPath: TOKENS_PATH });
  });

// --- Make Your Own cards ---

const paths = { configPath: CONFIG_PATH, tokensPath: TOKENS_PATH };
const num = (v: string) => Number(v);

function run(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  };
}

const card = program.command('card').description('List, show, create and edit MYO cards');

card
  .command('list')
  .description('List your MYO cards')
  .option('--json', 'Print the cards as JSON')
  .action(run((o) => myo.listCards(paths, o.json)));

card
  .command('show <cardId>')
  .description('Show a card: title, cover, and each chapter with its length and icon')
  .option('--json', 'Print the whole card as JSON')
  .action(run((cardId, o) => myo.showCard(paths, cardId, o.json)));

card
  .command('create <dir>')
  .description('Create a card from a folder of "NN - Title.mp3" files, one chapter per file')
  .option('--title <title>', 'Card title (default: folder name)')
  .option('--cover <image>', 'Cover image (jpg/png/gif/webp)')
  .option('--icon <icon>', 'Icon for every chapter: public icon name/ID, yotoicons:<id> or URL, tinker:<id> or URL, 16x16 image path, or yoto:#id')
  .option('--allow-duplicate', 'Create even if a card with this title exists', false)
  .option('--dry-run', 'Show the plan without uploading', false)
  .action(run((dir, o) => myo.createCard(paths, { dir, ...o })));

card
  .command('rename <cardId> <title>')
  .description('Rename a card')
  .option('--dry-run', 'Show the change without saving', false)
  .action(run((cardId, title, o) => myo.renameCard(paths, cardId, title, o.dryRun)));

card
  .command('cover <cardId> <image>')
  .description("Replace a card's cover image")
  .option('--dry-run', 'Show the change without uploading or saving', false)
  .action(run((cardId, image, o) => myo.setCover(paths, cardId, image, o.dryRun)));

const chapter = program.command('chapter').description('Edit one chapter of a MYO card (chapters count from 1)');

chapter
  .command('rename <cardId> <n> <title>')
  .description('Rename chapter n')
  .option('--dry-run', 'Show the change without saving', false)
  .action(run((cardId, n, title, o) => myo.renameChapter(paths, cardId, num(n), title, o.dryRun)));

chapter
  .command('icon <cardId> <n> <icon>')
  .description('Set the icon of chapter n: public icon name/ID, yotoicons:<id> or URL, tinker:<id> or URL, 16x16 image path, or yoto:#id')
  .option('--dry-run', 'Show the change without uploading or saving', false)
  .action(run((cardId, n, icon, o) => myo.setChapterIcon(paths, cardId, num(n), icon, o.dryRun)));

chapter
  .command('audio <cardId> <n> <file>')
  .description('Replace the audio of chapter n, keeping its title and icon')
  .option('--dry-run', 'Show the change without uploading or saving', false)
  .action(run((cardId, n, file, o) => myo.replaceChapterAudio(paths, cardId, num(n), file, o.dryRun)));

chapter
  .command('add <cardId> <file>')
  .description('Add a chapter from an audio file (default: at the end)')
  .option('--title <title>', 'Chapter title (default: from the file name)')
  .option('--at <n>', 'Position for the new chapter', num)
  .option('--icon <icon>', 'Public icon name/ID, yotoicons:<id> or URL, tinker:<id> or URL, 16x16 image path, or yoto:#id')
  .option('--dry-run', 'Show the change without uploading or saving', false)
  .action(run((cardId, file, o) => myo.addChapter(paths, cardId, file, o)));

chapter
  .command('remove <cardId> <n>')
  .description('Remove chapter n')
  .option('--dry-run', 'Show the change without saving', false)
  .action(run((cardId, n, o) => myo.removeChapter(paths, cardId, num(n), o.dryRun)));

chapter
  .command('move <cardId> <from> <to>')
  .description('Move chapter <from> to position <to>')
  .option('--dry-run', 'Show the change without saving', false)
  .action(run((cardId, from, to, o) => myo.moveChapter(paths, cardId, num(from), num(to), o.dryRun)));

program
  .command('prepare <manifest>')
  .description('Write a finished album to the Yoto library from an album.json manifest (see README)')
  .option('--root <dir>', 'Yoto library folder (default: YOTO_LIBRARY from .env)')
  .option('--dry-run', 'Show what would change without writing', false)
  .action(
    run(async (manifest, o) => {
      printReport(await prepareAlbum(manifest, { root: o.root ?? yotoLibrary(), dryRun: o.dryRun }), o.dryRun);
    })
  );

const icons = program.command('icons').description('Yoto public icons, Tinker icons and your own uploaded icons');

icons
  .command('search <query>')
  .description('Search public icons by name or tag')
  .action(run((query) => myo.searchPublicIcons(paths, query)));

icons
  .command('tinker <query>')
  .description('Search Tinker Icons by name, misspelling or meaning (needs TINKER_API_KEY in .env)')
  .option('--limit <n>', 'How many results, up to 100; each counts against 5,000 a day', '12')
  .option('--sheet <png>', 'Also write a picture of the results, numbered left to right')
  .action(run((query, o) => myo.searchTinkerIcons(query, { limit: num(o.limit), sheet: o.sheet })));

icons
  .command('mine')
  .description('List your uploaded icons as an HTML contact sheet, flagging duplicates')
  .option('--out <file>', 'Where to write the page', join(tmpdir(), 'yoto-my-icons.html'))
  .option('--sheet <png>', 'Also write pictures of them (<png>-1.png, -2.png, ...) and an index of where each icon is')
  .action(run((o) => myo.listMyIcons(paths, o.out, o.sheet)));

const labelPaths = () => ({ covers: join(yotoLibrary(), 'Cover images'), labels: join(yotoLibrary(), 'Labels') });
const labels = program.command('labels').description('Print sheets of card labels and track which cards have one (Labels/catalogue.json)');

labels
  .command('sync')
  .description('Add new Yoto cards to the catalogue and download covers missing from Cover images')
  .option('--dry-run', 'Show new cards and missing covers without writing anything', false)
  .action(run(async (o) => labelsCmd.sync(labelPaths(), await (await myo.connect(paths)).listCards(), o.dryRun)));

labels
  .command('sheet [cards...]')
  .description('Make an A4 PDF of labels for cards (by ID or words from the title) and mark them printed')
  .option('--format <year>', 'Sheet layout: 2026 (4x3 portrait) or 2025 (2x5 landscape, cut lines)', '2026')
  .option('--next', 'Fill the empty slots with the newest cards not printed yet', false)
  .option('--out <file>', 'Where to write the PDF (default: Labels/<date>-labels-<format>.pdf)')
  .option('--dry-run', 'List the labels without writing anything', false)
  .action(run(async (cards, o) => labelsCmd.makeSheet(labelPaths(), cards, o)));

labels
  .command('todo')
  .description('List cards not printed yet, newest first')
  .action(run(async () => labelsCmd.todo(labelPaths())));

program.parse();
