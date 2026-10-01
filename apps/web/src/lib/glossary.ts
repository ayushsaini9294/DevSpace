/**
 * The words DevSpace uses, in plain English for people new to programming (Phase 11). Every page
 * uses these names, and the "?" help tips explain them with these sentences.
 */
export const GLOSSARY = {
  copy: {
    term: 'your copy',
    help: 'Your copy is your own space to work in. It starts as a copy of main. What you change there doesn’t affect anyone else until you submit it and it’s merged.',
  },
  main: {
    term: 'main',
    help: 'Main is the team’s shared version of the project. It only changes when a leader merges submitted work, so it stays safe.',
  },
  submit: {
    term: 'Submit work',
    help: 'Submitting sends the changes you pick from your copy for review. Your copy stays as it is, and you can keep working.',
  },
  review: {
    term: 'review',
    help: 'A review is a teammate looking at submitted work. They can comment on lines, approve it, or ask for changes before it goes into main.',
  },
  merge: {
    term: 'Merge',
    help: 'Merging adds a submission’s changes to main, the team’s shared version. Only leaders and co-leaders can merge.',
  },
  clash: {
    term: 'clash',
    help: 'A clash (a “conflict”) happens when two people changed the same lines. DevSpace marks those lines in the file so you can choose what to keep.',
  },
  undo: {
    term: 'Undo merge',
    help: 'Undo merge takes a merged submission’s changes back out of main. The author keeps the work in their copy and can fix it and submit again.',
  },
  github: {
    term: 'GitHub',
    help: 'GitHub is a website where people keep and share code. Publishing puts a copy of main there, with its history, so you can show the project to others, for example in your portfolio.',
  },
  keepUpdated: {
    term: 'Keep updated',
    help: '“Publish once” sends main to GitHub one time. “Keep updated” also sends main again after every merge or undo. DevSpace never overwrites changes made directly on GitHub: it pauses and tells you instead.',
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
