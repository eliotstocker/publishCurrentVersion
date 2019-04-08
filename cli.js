#!/usr/bin/env node
"use strict";

const yargs = require("yargs/yargs");
const publishCommand = require('./command');
const publish = require('.');

const cli = yargs(process.argv.slice(2), process.cwd());

const command = publishCommand.builder(cli);

const pub = new publish.PublishCommand(command.argv);

pub
    .then(() => console.log('Publish complete successfully...'))
    .catch(e => console.error('Publish Failed...', e.message));
