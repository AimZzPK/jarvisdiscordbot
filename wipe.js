require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] })
  .then(() => console.log('✅ Commands wiped!'))
  .catch(console.error);