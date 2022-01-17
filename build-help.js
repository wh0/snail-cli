const fs = require('fs');
const path = require('path');

const commander = require('commander');

const packageMeta = require('./package.json');

const highSubs = new Map();
const highSubsOrder = [];
const highSubCodeStart = 0xe000;
let highSubCodeNext = highSubCodeStart;

function highSub(markup) {
  if (highSubs.has(markup)) return highSubs.get(markup);
  const code = highSubCodeNext++;
  if (code > 0xf8ff) throw new Error('too many highSub');
  const sub = String.fromCharCode(code);
  highSubs.set(markup, sub);
  highSubsOrder.push(markup);
  return sub;
}

function resetHighSubs() {
  highSubs.clear();
  highSubsOrder.splice(0, highSubsOrder.length);
  highSubCodeNext = highSubCodeStart;
}

function lowerHighSubs(s) {
  function replace(v, x, y) {
    return v.split(x).join(y);
  }
  let lowered = s;
  lowered = replace(lowered, '&', '&amp;');
  lowered = replace(lowered, '<', '&lt;');
  lowered = replace(lowered, '>', '&gt;');
  for (const markup of highSubsOrder) {
    lowered = replace(lowered, highSubs.get(markup), markup);
  }
  return lowered;
}

function briefNameFromCommand(cmd) {
  let name = cmd.name();
  for (let parentCmd = cmd.parent; parentCmd; parentCmd = parentCmd.parent) {
    name = `${parentCmd.name()} ${name}`;
  }
  return name;
}

function filenameFromCommand(cmd) {
  if (cmd === commander.program) return 'index.html';
  let filename = `${cmd.name()}.html`;
  for (
    let parentCmd = cmd.parent;
    parentCmd && parentCmd !== commander.program;
    parentCmd = parentCmd.parent
  ) {
    filename = `${parentCmd.name()}-${filename}`;
  }
  return filename;
}

function linkStartForCommand(cmd) {
  // Slight hack: don't create link for implicit help comand.
  if (cmd.name() === 'help') return '';
  return `<a href="${filenameFromCommand(cmd)}">`;
}

function linkEndForCommand(cmd) {
  if (cmd.name() === 'help') return '';
  return '</a>';
}

const stockHelp = new commander.Help();

commander.program.configureHelp({
  // If we've done everything right, the helpWidth shouldn't have any effect,
  // but set it to a fixed value just in case.
  helpWidth: 80,
  subcommandTerm: (cmd) => `${highSub(`<span class="subcommand-term">${linkStartForCommand(cmd)}`)}${stockHelp.subcommandTerm(cmd)}${highSub(`${linkEndForCommand(cmd)}</span>`)}`,
  optionTerm: (option) => `${highSub('<span class="option-term">')}${stockHelp.optionTerm(option)}${highSub('</span>')}`,
  // No overrides for the various length calculators. The non-displaying
  // high sub characters mess up the wrapping width, but our wrap
  // implementation ignores that.
  commandUsage: (cmd) => `${highSub('<span class="command-usage">')}${stockHelp.commandUsage(cmd)}${highSub('</span>')}`,
  commandDescription: (cmd) => `${highSub('<span class="command-description">')}${stockHelp.commandDescription(cmd)}${highSub('</span>')}`,
  subcommandDescription: (cmd) => `${highSub('<span class="subcommand-description">')}${stockHelp.subcommandDescription(cmd)}${highSub('</span>')}`,
  optionDescription: (option) => `${highSub('<span class="option-description">')}${stockHelp.optionDescription(option)}${highSub('</span>')}`,
  wrap: (str, width, indent, minColumnWidth = 40) => `${highSub('<span class="item">')}${highSub('<span class="term">')}${str.slice(0, indent)}${highSub('</span>')}${highSub('<span class="description">')}${str.slice(indent)}${highSub('</span>')}${highSub('</span>')}`,
});

// Haaaaaaaaaaaaaaaaaaaaaaaaaax.
commander.program.parse = () => { };
require('./src/index');

function visitCommand(cmd) {
  const briefName = briefNameFromCommand(cmd);
  const filename = filenameFromCommand(cmd);
  const dstPath = path.join('help-staging', filename);
  console.error(`${briefName} -> ${dstPath}`);

  let content = '';
  cmd.outputHelp({
    write: (chunk) => {
      content += chunk;
    },
  });
  const loweredContent = lowerHighSubs(content);
  resetHighSubs();

  const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${briefName} &mdash; Snail</title>
<script>
  if (window.location.protocol === 'http:' && !window.isSecureContext) {
    const httpsUrl = new URL(window.location.href);
    httpsUrl.protocol = 'https:';
    window.location.replace(httpsUrl.href);
  }
</script>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="stylesheet" href="../common.css">
<link rel="stylesheet" href="../help.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro:ital,wght@0,400;0,600;1,400&display=swap">
<link rel="icon" href="../snail.svg">
<link rel="canonical" href="https://snail-cli.glitch.me/help/${filename}">

<div class="header">
  <div class="line">
    <span class="prompt">$</span>
    <a class="home" href="/"><span class="snail">🐌</span><span class="command">snail</span></a>
    #
    <h1>Documentation</h1>
  </div>
</div>

<div class="block help-main">
<pre>
${loweredContent}</pre>
</div>

<div class="block help-misc">
  <p>
    Generated from Snail ${packageMeta.version}.
  </p>
</div>

<div class="footer"><span>Please do not write below this line.</span></div>
`;
  fs.writeFile(dstPath, page, (err) => {
    if (err) console.error(err);
  });

  for (const sub of cmd.commands) {
    visitCommand(sub);
  }
}

visitCommand(commander.program);
