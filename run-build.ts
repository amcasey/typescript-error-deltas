import process = require("process");
import ge = require("./getErrors");

if (!process.send) process.exit(1);

process.send('ready');

process.on('message', ({repoDir, tscPath, skipLibCheck}) => {
    ge.buildAndGetErrors(repoDir, tscPath, skipLibCheck)
      .then(r => { process.send!(r), process.exit(); });
});
