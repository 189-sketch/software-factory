// Preloaded by the npm test scripts (node --import). Test suites stub the
// agents they exercise; failure-driven learning would otherwise reach past
// those stubs and spawn the real `claude` CLI on a developer machine.
// Learning tests opt in through their own explicit environment.
process.env.FACTORY_LEARNING ??= "0";
