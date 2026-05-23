#!/usr/bin/env node

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';

const banner = `
${CYAN}${BOLD}  _  ______      _    _____ _____ ___  ${RESET}
${CYAN}${BOLD} | |/ /  _ \\    / \\  |  ___|_   _/ _ \\ ${RESET}
${CYAN}${BOLD} | ' /| |_) |  / _ \\ | |_    | || | | |${RESET}
${CYAN}${BOLD} | . \\|  _ <  / ___ \\|  _|   | || |_| |${RESET}
${CYAN}${BOLD} |_|\\_\\_| \\_\\/_/   \\_\\_|     |_| \\___/ ${RESET}
`;

const tagline = `${MAGENTA}${BOLD}  Visual editor for live web products${RESET}`;
const status = `${GRAY}  early preview${RESET}`;

const body = `
${BOLD}What's coming:${RESET}
  ${DIM}·${RESET} bird's-eye canvas of your real app pages
  ${DIM}·${RESET} AI-powered edits via Claude — no codegen-from-scratch
  ${DIM}·${RESET} one-command onboarding for any React / Next / Vite project

${BOLD}Status:${RESET} this is an early preview of the Krafto CLI.
The interactive ${BOLD}krafto init${RESET} flow ships in an upcoming release.

${BOLD}Follow the build:${RESET}
  ${CYAN}https://github.com/cranch42/yondo${RESET}

${GRAY}Subscribe for updates — open an issue on the repo above.${RESET}
`;

process.stdout.write(banner);
process.stdout.write(tagline + '\n');
process.stdout.write(status + '\n');
process.stdout.write(body + '\n');
