/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
// Electron must finish its synchronous bootstrap before the asynchronous driver.
const { app } = require('electron');
app.setPath('userData', process.env.CANVAS_WHEEL_PROFILE);
import(process.env.CANVAS_WHEEL_DRIVER).catch((error) => {
  console.error(error);
  app.exit(1);
});
