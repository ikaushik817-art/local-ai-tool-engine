#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectName = process.argv[2];
if (!projectName) {
  console.error('Usage: npx create-local-ai-tool <project-name>');
  process.exit(1);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectName)) {
  console.error('Use a project name with only letters, numbers, dots, underscores, or hyphens.');
  process.exit(1);
}

const projectDir = path.resolve(process.cwd(), projectName);
try {
  await mkdir(projectDir, { recursive: false });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`Folder already exists: ${projectName}. Choose another name or remove that folder first.`);
  } else {
    console.error(`Could not create project folder: ${error.message}`);
  }
  process.exit(1);
}

const files = {
  'package.json': JSON.stringify({
    name: projectName.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'node app.js' },
    dependencies: { 'create-local-ai-tool': '^1.0.0' }
  }, null, 2) + '\n',
  'app.js': `import { createAI } from "create-local-ai-tool";\n\nconst ai = createAI();\n\n// Add your own tools with ai.registerTool({...}).\nconst answer = await ai.chat("Hi! Introduce yourself briefly.");\nconsole.log(answer);\n`,
  '.gitignore': 'node_modules/\n.env\n',
  'README.md': `# ${projectName}\n\n## Run it\n\n1. Install [Ollama](https://ollama.com/download) and start it.\n2. Download the default model once: \`ollama pull qwen2.5:3b\`\n3. Run:\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n\nTo use a different Ollama model, set the \`OLLAMA_MODEL\` environment variable before starting the app.\n`
};

for (const [name, content] of Object.entries(files)) {
  await writeFile(path.join(projectDir, name), content, { flag: 'wx' });
}

console.log(`\nCreated ${projectName}.`);
console.log('Installing project dependencies...');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install'], { cwd: projectDir, stdio: 'inherit', shell: process.platform === 'win32' });
if (install.status !== 0) {
  console.error('\nDependency installation failed. Check your internet connection and run "npm install" inside the project folder.');
  process.exit(1);
}

console.log('\nSetup complete!');
console.log(`  cd ${projectName}`);
console.log('  npm start');
console.log('\nRequirement: Ollama must be installed and running, with qwen2.5:3b downloaded.');
