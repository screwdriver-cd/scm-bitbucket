# scm-bitbucket
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> This scm plugin extends the [scm-base-class](https://github.com/screwdriver-cd/scm-base), and provides methods to fetch and update data in Bitbucket.

## Usage

```bash
npm install screwdriver-scm-bitbucket
```
#### parseUrl
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config             | Object | Configuration Object |
| config.checkoutUrl | String | Checkout url for a repo to parse |
| config.token  | String | Access token for scm |

#### Output: Promise
1. Resolves to an scm uri for the repository. Ex: `bitbucket.org:batman/{1234}:branchName`, where `batman` is the repository's owner and `{1234}` is repository's uuid.
2. Rejects if not able to parse url

### parseHook
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| headers        | Object | Request header |
| payload        | Object | Request payload |

#### Output: Promise
1. Resolves to an object with the following fields:
```js
{
    type: 'pr',         // can be 'pr' or 'repo'
    action: 'opened',   // can be 'opened', 'closed', or 'synchronized' for type 'pr'; 'push' for type 'repo'
    username: 'batman',
    url: 'https://batman@bitbucket.org/batman/test.git',
    branch: 'mynewbranch',
    sha: '40171b678527',
    prNumber: 3,
    prRef: 'refs/pull-requests/3/from'
}
```
2. Rejects if not able to parse webhook payload

### decorateUrl
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUri | String | Scm uri (ex: `bitbucket.org:batman/{1234}:branchName`) |
| config.token  | String | Access token for scm |

#### Expected Outcome
Decorated url in the form of:
```js
{
    url: 'https://bitbucket.org/batman/test.git',
    name: 'batman/test',
    branch: 'mybranch'
}
```

#### Expected Promise response
1. Resolve with a decorated url object for the repository
2. Reject if not able to get decorate url

### decorateCommit
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.sha     | String | Commit sha to decorate |
| config.scmUri        | String | Scm uri (ex: `bitbucket.org:1234:branchName`) |
| config.token | String | Access token for scm |

#### Expected Outcome
Decorated commit in the form of:
```js
{
    url: 'https://bitbucket.org/screwdriver-cd/scm-base/commit/5c3b2cc64ee4bdab73e44c394ad1f92208441411',
    message: 'Use screwdriver to publish',
    author: {
        url: 'https://bitbucket.org/d2lam',
        name: 'Dao Lam',
        username: 'd2lam',
        avatar: 'https://bitbucket.org/account/d2lam/avatar/32/'
    }
}
```

#### Expected Promise response
1. Resolve with a decorated commit object for the repository
2. Reject if not able to decorate commit

### decorateAuthor
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.username     | String | Author to decorate |
| config.token | String | Access token for scm |

#### Expected Outcome
Decorated author in the form of:
```js
{
    url: 'https://bitbucket.org/d2lam',
    name: 'Dao Lam',
    username: 'd2lam',
    avatar: 'https://bitbucket.org/account/d2lam/avatar/32/'
}
```

#### Expected Promise response
1. Resolve with a decorated author object for the repository
2. Reject if not able to decorate author

### getPermissions
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUri | String | The scm uri to get permissions on (ex: `bitbucket.org:batman/{1234}:branchName`) |
| config.token | String | Access token for scm |

#### Expected Outcome
Permissions for a given token on a repository in the form of:
```js
{
    admin: true,
    push: true,
    pull: true
}
```

#### Expected Promise response
1. Resolve with a permissions object for the repository
2. Reject if not able to get permissions

### getCommitSha
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUri | String | The scm uri (ex: `bitbucket.orgin:batman/{1234}:branchName`) |
| config.token | String | Access token for scm |

#### Expected Outcome
The commit sha for a given branch on a repository.

#### Expected Promise response
1. Resolve with a commit sha string for the given `scmUri`
2. Reject if not able to get a sha

### getFile
The parameters required are:

| Parameter        | Type  | Required | Description |
| :-------------   | :---- | :------- | :-------------|
| config        | Object | true | Configuration Object |
| config.scmUri | String | true | The scm uri (ex: `bitbucket.org:batman/{1234}:branchName`) |
| config.token | String | true | Access token for scm |
| config.path | String | true | The path to the file on scm to read. For example: `screwdriver.yaml` |
| config.ref | String | false | The reference to the scm repo, could be a branch or sha |

#### Expected Outcome
The contents of the file at `path` in the repository

#### Expected Promise Response
1. Resolve with the contents of `path`
2. Reject if the `path` cannot be downloaded, decoded, or is not a file

### updateCommitStatus
The parameters required are:

| Parameter        | Type  | Required | Description |
| :-------------   | :---- | :------- | :-------------|
| config        | Object | true | Configuration Object |
| config.scmUri | String | true | The scm uri (ex: `bitbucket.org:batman/{1234}:branchName`) |
| config.token | String | true | Access token for scm |
| config.sha | String | true | The scm sha to update a status for |
| config.buildStatus | String | true | The screwdriver build status to translate into scm commit status |
| config.url | String | false | The target url for setting up details |

#### Expected Outcome
Update the commit status for a given repository and sha.

#### Expected Promise Response
1. Resolves to response when the commit status was updated
2. Reject if the commit status fails to update

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
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/scm-bitbucket.svg
[issues-url]: https://github.com/screwdriver-cd/scm-bitbucket/issues
[status-image]: https://cd.screwdriver.cd/pipelines/d4411e1a5ab81278499dd2a478eb355cf1f2dbda/badge
[status-url]: https://cd.screwdriver.cd/pipelines/d4411e1a5ab81278499dd2a478eb355cf1f2dbda
[daviddm-image]: https://david-dm.org/screwdriver-cd/scm-bitbucket.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/scm-bitbucket
