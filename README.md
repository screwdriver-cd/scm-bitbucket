# scm-bitbucket
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] ![License][license-image]

> This scm plugin extends the [scm-base-class](https://github.com/screwdriver-cd/scm-base), and provides methods to fetch and update data in Bitbucket.

## Usage

```bash
npm install screwdriver-scm-bitbucket
```

### Initialization

The class has a variety of knobs to tweak when interacting with Bitbucket.org.

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.oauthClientId | String | OAuth Client ID provided by Bitbucket application |
| config.oauthClientSecret | String | OAuth Client Secret provided by Bitbucket application |
| config.username (sd-buildbot) | String | Bitbucket username for checkout |
| config.email (dev-null@screwdriver.cd) | String | Bitbucket user email for checkout |
| config.https (false) | Boolean | Is the Screwdriver API running over HTTPS |
| config.fusebox ({}) | Object | [Circuit Breaker configuration][circuitbreaker] |
```js
const scm = new BitbucketScm({
    oauthClientId: 'your-client-id',
    oauthClientSecret: 'your-client-secret'
});
```

### Methods

#### getScmContexts

No parameters are required.

##### Expected Outcome

A single element array of ScmContext(ex: `['bitbucket:bitbucket.org']`), which will be a unique identifier for the scm.
Since scm-bitbucket supports only 'bitbucket.org' now, this method returns fixed value.

For more information on the exposed methods please see the [scm-base-class].

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-scm-bitbucket.svg
[npm-url]: https://npmjs.org/package/screwdriver-scm-bitbucket
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-scm-bitbucket.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-scm-bitbucket.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/screwdriver.svg
[issues-url]: https://github.com/screwdriver-cd/screwdriver/issues
[status-image]: https://cd.screwdriver.cd/pipelines/15/badge
[status-url]: https://cd.screwdriver.cd/pipelines/15
[scm-base-class]: https://github.com/screwdriver-cd/scm-base
