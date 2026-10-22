let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(input.split(/\r?\n/).map(line => line.trimEnd()).join('\n'));
