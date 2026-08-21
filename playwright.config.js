module.exports = {
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
};
