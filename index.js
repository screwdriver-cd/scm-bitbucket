/* eslint-disable no-underscore-dangle */

'use strict';

const Breaker = require('circuit-fuses').breaker;
const Scm = require('screwdriver-scm-base');
const hoek = require('@hapi/hoek');
const joi = require('joi');
const logger = require('screwdriver-logger');
const Path = require('path');
const Url = require('url');
const request = require('screwdriver-request');
const schema = require('screwdriver-data-schema');
const CHECKOUT_URL_REGEX = schema.config.regex.CHECKOUT_URL;
const API_URL_V2 = 'https://api.bitbucket.org/2.0';
const REPO_URL = `${API_URL_V2}/repositories`;
const USER_URL = `${API_URL_V2}/users`;
const MATCH_COMPONENT_HOSTNAME = 1;
const MATCH_COMPONENT_USER = 2;
const MATCH_COMPONENT_REPO = 3;
const MATCH_COMPONENT_BRANCH = 4;
const MATCH_COMPONENT_ROOTDIR = 5;
const BRANCH_PAGE_SIZE = 100;
const STATE_MAP = {
    SUCCESS: 'SUCCESSFUL',
    RUNNING: 'INPROGRESS',
    QUEUED: 'INPROGRESS',
    FAILURE: 'FAILED',
    ABORTED: 'STOPPED'
};
const WEBHOOK_PAGE_SIZE = 30;
const DEFAULT_BRANCH = 'master';

/**
 * Throw error with error code
 * @param {String} errorReason Error message
 * @param {Number} errorCode   Error code
 * @throws {Error}             Throws error
 */
function throwError(errorReason, errorCode = 500) {
    const err = new Error(errorReason);

    err.statusCode = errorCode;
    throw err;
}

/**
 * Get repo information
 * @method  getRepoInfo
 * @param   {String}    checkoutUrl     The url to check out repo
 * @param   {String}    [rootDir]       Root dir of the pipeline
 * @return  {Object}                    An object with hostname, repo, branch, and username
 */
function getRepoInfo(checkoutUrl, rootDir) {
    const matched = CHECKOUT_URL_REGEX.exec(checkoutUrl);

    // Check if regex did not pass
    if (!matched) {
        throw new Error(`Invalid scmUrl: ${checkoutUrl}`);
    }

    const rootDirFromScmUrl = matched[MATCH_COMPONENT_ROOTDIR];

    return {
        hostname: matched[MATCH_COMPONENT_HOSTNAME],
        repo: matched[MATCH_COMPONENT_REPO],
        branch: matched[MATCH_COMPONENT_BRANCH] ? matched[MATCH_COMPONENT_BRANCH].slice(1) : null,
        username: matched[MATCH_COMPONENT_USER],
        rootDir: rootDir || (rootDirFromScmUrl ? rootDirFromScmUrl.slice(1) : undefined)
    };
}

/**
 * Get hostname, repoId, branch, and rootDir from scmUri
 * @method getScmUriParts
 * @param  {String}     scmUri
 * @return {Object}
 */
function getScmUriParts(scmUri) {
    const scm = {};

    [scm.hostname, scm.repoId, scm.branch, scm.rootDir] = scmUri.split(':');

    return scm;
}

class BitbucketScm extends Scm {
    /**
     * Bitbucket command to run
     * @method _gitlabCommand
     * @param  {Object}      options              An object that tells what command & params to run
     * @param  {Object}      [options.json]       Body for request to make
     * @param  {String}      options.method       Bitbucket method. For example: get
     * @param  {String}      options.route        Route for gitlab.request()
     * @param  {String}      options.token        Bitbucket token used for authentication of requests
     * @param  {Function}    callback             Callback function from gitlab API
     */
    _bitbucketCommand(options, callback) {
        const config = options;

        // Everything else goes into context
        config.context = {
            token: options.token
        };
        delete config.token;

        request(config)
            .then(function cb() {
                // Use "function" (not "arrow function") for getting "arguments"
                callback(null, ...arguments);
            })
            .catch(err => callback(err));
    }

    /**
     * Constructor for Scm
     * @method constructor
     * @param  {String}  options.oauthClientId       OAuth Client ID provided by Bitbucket application
     * @param  {String}  options.oauthClientSecret   OAuth Client Secret provided by Bitbucket application
     * @param  {String}  [options.username=sd-buildbot]           Bitbucket username for checkout
     * @param  {String}  [options.email=dev-null@screwdriver.cd]  Bitbucket user email for checkout
     * @param  {Object}  [options.readOnly={}]       Read-only SCM instance config with: enabled, username, accessToken, cloneType
     * @param  {Boolean} [options.https=false]       Is the Screwdriver API running over HTTPS
     * @param  {Object}  [options.fusebox={}]        Circuit Breaker configuration
     * @return {BitbucketScm}
     */
    constructor(config = {}) {
        super();

        this.config = joi.attempt(
            config,
            joi
                .object()
                .keys({
                    username: joi.string().optional().default('sd-buildbot'),
                    email: joi.string().optional().default('dev-null@screwdriver.cd'),
                    readOnly: joi
                        .object()
                        .keys({
                            enabled: joi.boolean().optional(),
                            username: joi.string().optional(),
                            accessToken: joi.string().optional(),
                            cloneType: joi.string().valid('https', 'ssh').optional().default('https')
                        })
                        .optional()
                        .default({}),
                    https: joi.boolean().optional().default(false),
                    oauthClientId: joi.string().required(),
                    oauthClientSecret: joi.string().required(),
                    fusebox: joi.object().default({})
                })
                .unknown(true),
            'Invalid config for Bitbucket'
        );

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._bitbucketCommand.bind(this), {
            // Do not retry when there is a 4XX error
            shouldRetry: err => err && err.status && !(err.status >= 400 && err.status < 500),
            retry: this.config.fusebox.retry,
            breaker: this.config.fusebox.breaker
        });

        // TODO: set fixed value temporarily.
        // need to change if the other bitbucket host is supported.
        this.hostname = 'bitbucket.org';

        // TODO: find a better access token renewal process
        // Tracks the generated authentication token/refresh-token in memory so that we can re-use authentication.
        // Relying on the token passed in may result in using a token that expires.
        // This token should only be use for READ API calls.  Any WRITE API calls should
        // continue to use the token passed in regardless of whether it expires or not to ensure
        // that all WRITE to Bitbucket is under the user that is initiating it.
        // REF(1713) - Bitbucket tokens expires after 1-2 hours
        this.token = '';
        this.refreshToken = '';
        this.expiresIn = 0;
    }

    /**
     * Get the webhook events mapping of screwdriver events and scm events
     * @method _getWebhookEventsMapping
     * @return {Object}     Returns a mapping of the events
     */
    _getWebhookEventsMapping() {
        return {
            pr: ['pullrequest:created', 'pullrequest:fulfilled', 'pullrequest:rejected', 'pullrequest:updated'],
            commit: 'push'
        };
    }

    /**
     * Look for a specific webhook that is attached to a repo.
     *
     * Searches through the webhook pages until the given webhook URL is found. If nothing is found, this will
     * return nothing. If a status response of non-200 is encountered, the chain is rejected with the
     * HTTP operation and the status code received.
     * @async _findWebhook
     * @param  {Object}     config
     * @param  {Number}     config.page    pagination: page number to search next. 1-index.
     * @param  {String}     config.repoId  The bitbucket repo ID (e.g., "username/repoSlug")
     * @param  {String}     config.token   Admin Oauth2 token for the repo
     * @param  {String}     config.url     url for webhook notifications
     * @return {Promise}                   Resolves to a webhook information payload
     */
    async _findWebhook({ page, repoId, token: configToken, url }) {
        try {
            const token = await this._getToken();
            const response = await this.breaker.runCommand({
                method: 'GET',
                token,
                url: `${REPO_URL}/${repoId}/hooks?pagelen=30&page=${page}`
            });

            const hooks = response.body;
            const result = hooks.values.find(webhook => webhook.url === url);

            if (!result && hooks.size >= WEBHOOK_PAGE_SIZE) {
                return this._findWebhook({
                    page: page + 1,
                    repoId,
                    token: configToken,
                    url
                });
            }

            return result;
        } catch (err) {
            logger.error('Failed to findWebhook: ', err);
            throw err;
        }
    }

    /**
     * Creates and updates the webhook that is attached to a repo.
     *
     * By default, it creates a new webhook. If given a webhook payload, it will instead update the webhook to
     * ensure the correct settings are in place. If a status response of non-200 is encountered, the chain is
     * rejected with the HTTP operation and the status code received.
     * @method _createWebhook
     * @param  {Object}       config
     * @param  {Object}       [config.hookInfo] Information about an existing webhook
     * @param  {String}       config.repoId     Bitbucket repo ID (e.g., "username/repoSlug")
     * @param  {String}       config.token      Admin Oauth2 token for the repo
     * @param  {String}       config.url        url to create for webhook notifications
     * @param  {String}       config.actions    Actions for the webhook events
     * @return {Promise}                        Resolves when complete
     */
    _createWebhook({ hookInfo, repoId, token, url, actions }) {
        const params = {
            json: {
                description: 'Screwdriver-CD build trigger',
                url,
                active: true,
                events:
                    actions.length === 0
                        ? [
                              'repo:push',
                              'pullrequest:created',
                              'pullrequest:fulfilled',
                              'pullrequest:rejected',
                              'pullrequest:updated'
                          ]
                        : actions
            },
            method: 'POST',
            token,
            url: `${REPO_URL}/${repoId}/hooks`
        };

        if (hookInfo) {
            params.url = `${params.url}/${hookInfo.uuid}`;
            params.method = 'PUT';
        }

        try {
            return this.breaker.runCommand(params);
        } catch (err) {
            logger.error('Failed to createWebhook: ', err);
            throw err;
        }
    }

    /**
     * Adds the Screwdriver webhook to the Bitbucket repository
     *
     * By default, it will attach the webhook to the repository. If the webhook URL already exists, then it
     * is instead updated.
     * @method _addWebhook
     * @param  {Object}    config
     * @param  {String}    config.scmUri     The SCM URI to add the webhook to
     * @param  {String}    config.token      Oauth2 token to authenticate with Bitbucket
     * @param  {String}    config.webhookUrl The URL to use for the webhook notifications
     * @param  {String}    config.actions    Actions for the webhook events
     * @return {Promise}                     Resolves upon success
     */
    _addWebhook({ scmUri, token, webhookUrl, actions }) {
        const repoInfo = getScmUriParts(scmUri);

        return this._findWebhook({
            page: 1,
            repoId: repoInfo.repoId,
            token,
            url: webhookUrl
        }).then(hookInfo =>
            this._createWebhook({
                hookInfo,
                repoId: repoInfo.repoId,
                actions,
                token,
                url: webhookUrl
            })
        );
    }

    /**
     * Parse the url for a repo for the specific source control
     * @async parseUrl
     * @param  {Object}    config
     * @param  {String}    config.checkoutUrl   Url to parse
     * @param  {String}    [config.rootDir]     The root directory
     * @param  {String}    config.token         The token used to authenticate to the SCM
     * @return {Promise}                        Resolves to scmUri
     */
    async _parseUrl({ checkoutUrl, rootDir }) {
        const {
            branch: branchFromCheckout,
            username,
            repo,
            hostname,
            rootDir: sourceDir
        } = getRepoInfo(checkoutUrl, rootDir);
        // TODO: add logic to fetch default branch
        // See https://jira.atlassian.com/browse/BCLOUD-20212
        const branch = branchFromCheckout || DEFAULT_BRANCH;
        const branchUrl = `${REPO_URL}/${username}/${repo}/refs/branches/${branch}`;
        const token = await this._getToken();

        const options = {
            url: branchUrl,
            method: 'GET',
            token
        };

        if (hostname !== this.hostname) {
            throwError('This checkoutUrl is not supported for your current login host.', 400);
        }

        try {
            const response = await this.breaker.runCommand(options);
            const scmUri = `${hostname}:${username}/${response.body.target.repository.uuid}:${branch}`;

            return sourceDir ? `${scmUri}:${sourceDir}` : scmUri;
        } catch (err) {
            logger.error('Failed to parseUrl: ', err);
            throw err;
        }
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @method parseHook
     * @param  {Object}  headers  The request headers associated with the webhook payload
     * @param  {Object}  payload  The webhook payload received from the SCM service.
     * @return {Object}           A key-map of data related to the received payload
     */
    async _parseHook(headers, payload) {
        const [typeHeader, actionHeader] = headers['x-event-key'].split(':');
        const parsed = {};
        const scmContexts = this._getScmContexts();

        parsed.hookId = headers['x-request-uuid'];
        parsed.scmContext = scmContexts[0];

        if (hoek.reach(payload, 'repository.links.html.href') === undefined) {
            throwError('Invalid webhook payload', 400);
        }

        const link = Url.parse(hoek.reach(payload, 'repository.links.html.href'));
        const checkoutUrl = `${link.protocol}//${link.hostname}${link.pathname}.git`;

        if (!`${link.hostname}${link.pathname}.git`.startsWith(this.hostname)) {
            throwError(`Incorrect checkout SshHost: ${checkoutUrl}`, 400);
        }

        switch (typeHeader) {
            case 'repo': {
                if (actionHeader !== 'push') {
                    return null;
                }
                const changes = hoek.reach(payload, 'push.changes');

                parsed.type = 'repo';
                parsed.action = 'push';
                parsed.username = hoek.reach(payload, 'actor.uuid');
                parsed.checkoutUrl = checkoutUrl;
                parsed.branch = hoek.reach(changes[0], 'new.name');
                parsed.sha = hoek.reach(changes[0], 'new.target.hash');
                parsed.lastCommitMessage = hoek.reach(changes[0], 'new.target.message', { default: '' });

                return parsed;
            }
            case 'pullrequest': {
                if (actionHeader === 'created') {
                    parsed.action = 'opened';
                } else if (actionHeader === 'updated') {
                    parsed.action = 'synchronized';
                } else if (actionHeader === 'fullfilled' || actionHeader === 'rejected') {
                    parsed.action = 'closed';
                } else {
                    return null;
                }

                parsed.type = 'pr';
                parsed.username = hoek.reach(payload, 'actor.uuid');
                parsed.checkoutUrl = checkoutUrl;
                parsed.branch = hoek.reach(payload, 'pullrequest.destination.branch.name');
                parsed.sha = hoek.reach(payload, 'pullrequest.source.commit.hash');
                parsed.prNum = hoek.reach(payload, 'pullrequest.id');
                parsed.prRef = hoek.reach(payload, 'pullrequest.source.branch.name');

                const state = hoek.reach(payload, 'pullrequest.state');

                parsed.prMerged = state === 'MERGED';

                return parsed;
            }
            default:
                return null;
        }
    }

    /**
     * Decorate the author based on the Bitbucket
     * @async _decorateAuthor
     * @param  {Object}        config          Configuration object
     * @param  {Object}        config.token    Access token to authenticate with Bitbucket
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}                       Resolves to a decorated author with url, name, username, avatar
     */
    async _decorateAuthor({ username }) {
        try {
            const token = await this._getToken();
            const options = {
                url: `${USER_URL}/${encodeURIComponent(username)}`,
                method: 'GET',
                token
            };

            const { body } = await this.breaker.runCommand(options);

            return {
                id: hoek.reach(body, 'uuid'),
                url: hoek.reach(body, 'links.html.href'),
                name: hoek.reach(body, 'display_name'),
                username: hoek.reach(body, 'uuid'),
                avatar: hoek.reach(body, 'links.avatar.href')
            };
        } catch (err) {
            if (err.statusCode === 404) {
                // Bitbucket API has changed, cannot use strict username request anymore, for now we will
                // have to return a simple generated decoration result to allow all builds to function.
                // We will only allow this if the username is not a {uuid} pattern. Since if this is a {uuid}
                // pattern, this likely is a valid 404.
                return {
                    url: '',
                    name: username,
                    username,
                    avatar: ''
                };
            }
            logger.error('Failed to decorateAuthor: ', err);
            throw err;
        }
    }

    /**
     * Decorate a given SCM URI with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the master branch
     * @async decorateUrl
     * @param  {Config}    config         Configuration object
     * @param  {String}    config.scmUri  The scmUri
     * @param  {String}    config.token   Service token to authenticate with Bitbucket
     * @return {Object}                   Resolves to a decoratedUrl with url, name, and branch
     */
    async _decorateUrl({ scmUri }) {
        const { branch, repoId, rootDir } = getScmUriParts(scmUri);
        const token = await this._getToken();
        const options = {
            url: `${REPO_URL}/${repoId}`,
            method: 'GET',
            token
        };

        try {
            const { body } = await this.breaker.runCommand(options);

            return {
                url: body.links.html.href,
                name: body.full_name,
                branch,
                rootDir: rootDir || ''
            };
        } catch (err) {
            logger.error('Failed to decorateUrl: ', err);
            throw err;
        }
    }

    /**
     * Decorate the commit based on the repository
     * @async _decorateCommit
     * @param  {Object}     config           Configuration object
     * @param  {Object}     config.sha       Commit sha to decorate
     * @param  {Object}     config.scmUri    The scmUri that the commit belongs to
     * @param  {Object}     config.token     Service token to authenticate with Bitbucket
     * @return {Promise}                     Resolves to a decorated object with url, message, and author
     */
    async _decorateCommit({ scmUri, sha, token: configToken }) {
        const scm = getScmUriParts(scmUri);
        const token = await this._getToken();
        const options = {
            url: `${REPO_URL}/${scm.repoId}/commit/${sha}`,
            method: 'GET',
            token
        };

        try {
            const { body } = await this.breaker.runCommand(options);

            return this._decorateAuthor({
                username: body.author.user.uuid,
                token: configToken
            }).then(author => ({
                url: body.links.html.href,
                message: body.message,
                author
            }));
        } catch (err) {
            logger.error('Failed to decorateCommit: ', err);
            throw err;
        }
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @async getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  [config.prNum]    The PR number used to fetch the PR
     * @return {Promise}                    Resolves to the sha for the scmUri
     */
    async _getCommitSha(config) {
        if (config.prNum) {
            return this._getPrInfo(config).then(pr => pr.sha);
        }

        const scm = getScmUriParts(config.scmUri);
        const branchUrl = `${REPO_URL}/${scm.repoId}/refs/branches/${scm.branch}`;
        const token = await this._getToken();
        const options = {
            url: branchUrl,
            method: 'GET',
            token
        };

        try {
            const { body } = await this.breaker.runCommand(options);

            return body.target.hash;
        } catch (err) {
            logger.error('Failed to getCommitSha: ', err);
            throw err;
        }
    }

    /**
     * Bitbucket doesn't have an equivalent endpoint to get the changed files,
     * so returning null for now
     * @method getChangedFiles
     * @param  {Object}   config              Configuration
     * @param  {String}   config.type            Can be 'pr' or 'repo'
     * @param  {Object}   config.webhookPayload  The webhook payload received from the
     *                                           SCM service.
     * @param  {String}   config.token           Service token to authenticate with Bitbucket
     * @return {Promise}                      Resolves to the content of the file
     */
    _getChangedFiles() {
        return Promise.resolve(null);
    }

    /**
     * Fetch content of a file from Bitbucket
     * @async getFile
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri
     * @param  {String}   config.path         The file in the repo to fetch or full checkout URL
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   [config.ref]        The reference to the SCM, either branch or sha
     * @return {Promise}                      Resolves to the content of the file
     */
    async _getFile({ scmUri, ref, path }) {
        let fullPath = path;
        let username;
        let repo;
        let branch;
        let rootDir;
        let repoId;
        const token = await this._getToken();

        // If full path to a file is provided, e.g. git@github.com:screwdriver-cd/scm-github.git:path/to/a/file.yaml
        if (CHECKOUT_URL_REGEX.test(path)) {
            ({ username, repo, branch, rootDir } = getRepoInfo(fullPath));
            fullPath = rootDir;
            repoId = `${username}/${repo}`;
        } else {
            const scmUriParts = getScmUriParts(scmUri);

            ({ repoId, rootDir } = scmUriParts);
            branch = ref || scmUriParts.branch;

            fullPath = rootDir ? Path.join(rootDir, path) : path;
        }

        const fileUrl = `${REPO_URL}/${repoId}/src/${branch}/${fullPath}`;
        const options = {
            url: fileUrl,
            method: 'GET',
            token,
            responseType: 'buffer'
        };

        try {
            const response = await this.breaker.runCommand(options);

            return Buffer.from(response.body, 'utf8').toString();
        } catch (err) {
            logger.error('Failed to getFile: ', err);

            if (err.statusCode === 404) {
                // Returns an empty file if there is no screwdriver.yaml
                return '';
            }

            throw err;
        }
    }

    /**
     * Get a user's permissions on a repository
     * @async _getPermissions
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}                    Resolves to permissions object with admin, push, pull
     */
    async _getPermissions(config) {
        const { scmUri, token } = config;
        const scm = getScmUriParts(scmUri);
        const [owner, uuid] = scm.repoId.split('/');

        try {
            // First, check to see if the repository exists
            await this.breaker.runCommand({
                url: `${REPO_URL}/${owner}/${uuid}`,
                method: 'GET',
                token
            });
        } catch (err) {
            logger.error('Failed to get repository: ', err);
            throw err;
        }

        const getPerm = async desiredAccess => {
            const options = {
                url: `${REPO_URL}/${owner}?q=uuid%3D%22${uuid}%22`,
                method: 'GET',
                token
            };

            if (desiredAccess === 'admin') {
                options.url = `${options.url}&role=admin`;
            } else if (desiredAccess === 'push') {
                options.url = `${options.url}&role=contributor`;
            } else {
                options.url = `${options.url}`;
            }

            try {
                return this.breaker.runCommand(options).then(response => {
                    if (response.body.values) {
                        return response.body.values.some(r => r.uuid === uuid);
                    }

                    return false;
                });
            } catch (err) {
                logger.error('Failed to get permissions: ', err);
                throw err;
            }
        };

        return Promise.all([getPerm('admin'), getPerm('push'), getPerm('pull')]).then(([admin, push, pull]) => ({
            admin,
            push,
            pull
        }));
    }

    /**
     * Update the commit status for a given repo and sha
     * @method updateCommitStatus
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri
     * @param  {String}   config.sha          The sha to apply the status to
     * @param  {String}   config.buildStatus  The screwdriver build status to translate into scm commit status
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.url          Target Url of this commit status
     * @param  {String}   config.jobName      Optional name of the job that finished
     * @param  {Number}   config.pipelineId   Pipeline ID
     * @return {Promise}
     */
    async _updateCommitStatus({ scmUri, sha, buildStatus, url, jobName, pipelineId, token }) {
        const scm = getScmUriParts(scmUri);
        let context = `Screwdriver/${pipelineId}/`;

        context += /^PR/.test(jobName) ? 'PR' : jobName;

        const options = {
            url: `${REPO_URL}/${scm.repoId}/commit/${sha}/statuses/build`,
            method: 'POST',
            json: {
                url,
                state: STATE_MAP[buildStatus],
                key: sha,
                description: context
            },
            token: decodeURIComponent(token)
        };

        try {
            return this.breaker.runCommand(options);
        } catch (err) {
            if (err.statusCode !== 422) {
                logger.error('Failed to getFile: ', err);
                throw err;
            }

            return undefined;
        }
    }

    /**
     * Return a valid Bell configuration (for OAuth)
     * @method getBellConfiguration
     * @return {Promise}
     */
    _getBellConfiguration() {
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];
        const cookie = `bitbucket-${this.hostname}`;

        return Promise.resolve({
            [scmContext]: {
                provider: 'bitbucket',
                cookie,
                clientId: this.config.oauthClientId,
                clientSecret: this.config.oauthClientSecret,
                isSecure: this.config.https,
                forceHttps: this.config.https
            }
        });
    }

    /**
     * Checkout the source code from a repository; resolves as an object with checkout commands
     * @method getCheckoutCommand
     * @param  {Object}    config
     * @param  {String}    config.branch         Pipeline branch
     * @param  {String}    config.host           Scm host to checkout source code from
     * @param  {String}    config.org            Scm org name
     * @param  {String}    config.repo           Scm repo name
     * @param  {String}    config.sha            Commit sha
     * @param  {String}    [config.commitBranch] Commit branch
     * @param  {String}    [config.prRef]        PR reference (can be a PR branch or reference)
     * @param  {Object}    [config.parentConfig] Config for parent pipeline
     * @param  {String}    [config.rootDir]      Root directory
     * @return {Promise}                         Resolves to object containing name and checkout commands
     */
    _getCheckoutCommand({
        branch: pipelineBranch,
        host,
        org,
        repo,
        sha,
        commitBranch,
        prRef: prReference,
        parentConfig,
        rootDir
    }) {
        const checkoutUrl = `${host}/${org}/${repo}`;
        const sshCheckoutUrl = `git@${host}:${org}/${repo}`;
        const branch = commitBranch || pipelineBranch;
        const checkoutRef = prReference ? branch : sha;
        const gitWrapper =
            "$(if git --version > /dev/null 2>&1; then echo 'eval'; else echo 'sd-step exec core/git'; fi)";
        const command = [];

        // Set recursive option
        command.push(
            'if [ ! -z $GIT_RECURSIVE_CLONE ] && [ $GIT_RECURSIVE_CLONE = false ]; ' +
                'then export GIT_RECURSIVE_OPTION=""; ' +
                'else export GIT_RECURSIVE_OPTION="--recursive"; fi'
        );

        // Set sparse option
        command.push(
            'if [ ! -z "$GIT_SPARSE_CHECKOUT_PATH" ]; ' +
                `then export GIT_SPARSE_OPTION="--no-checkout";` +
                `else export GIT_SPARSE_OPTION=""; fi`
        );

        // Checkout config pipeline if this is a child pipeline
        if (parentConfig) {
            const parentCheckoutUrl = `${parentConfig.host}/${parentConfig.org}/${parentConfig.repo}`; // URL for https
            const parentSshCheckoutUrl = `git@${parentConfig.host}:${parentConfig.org}/${parentConfig.repo}`; // URL for ssh
            const parentBranch = parentConfig.branch;
            const externalConfigDir = '$SD_ROOT_DIR/config';

            command.push(
                'if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                    `then export CONFIG_URL=${parentSshCheckoutUrl}; ` +
                    'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                    'then export CONFIG_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@' +
                    `${parentCheckoutUrl}; ` +
                    `else export CONFIG_URL=https://${parentCheckoutUrl}; fi`
            );

            command.push(`export SD_CONFIG_DIR=${externalConfigDir}`);

            // Git clone
            command.push(`echo 'Cloning external config repo ${parentCheckoutUrl}'`);
            command.push(
                'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; ' +
                    `then ${gitWrapper} ` +
                    `"git clone $GIT_SPARSE_OPTION $GIT_RECURSIVE_OPTION --quiet --progress --branch '${parentBranch}' ` +
                    '$CONFIG_URL $SD_CONFIG_DIR"; ' +
                    `else ${gitWrapper} ` +
                    '"git clone $GIT_SPARSE_OPTION --depth=50 --no-single-branch $GIT_RECURSIVE_OPTION --quiet --progress ' +
                    `--branch '${parentBranch}' $CONFIG_URL $SD_CONFIG_DIR"; fi`
            );

            // Sparse Checkout
            command.push(
                'if [ ! -z "$GIT_SPARSE_CHECKOUT_PATH" ];' +
                    'then $SD_GIT_WRAPPER "git sparse-checkout set $GIT_SPARSE_CHECKOUT_PATH" && ' +
                    '$SD_GIT_WRAPPER "git checkout"; fi'
            );

            // Reset to SHA
            command.push(`${gitWrapper} "git -C $SD_CONFIG_DIR reset --hard ${parentConfig.sha}"`);
            command.push(`echo Reset external config repo to ${parentConfig.sha}`);
        }

        // Git clone
        command.push(`echo 'Cloning ${checkoutUrl}, on branch ${branch}'`);

        // Use read-only clone type
        if (hoek.reach(this.config, 'readOnly.enabled')) {
            if (hoek.reach(this.config, 'readOnly.cloneType') === 'ssh') {
                command.push(`export SCM_URL=${sshCheckoutUrl}`);
            } else {
                command.push(
                    'if [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                        `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
                        `else export SCM_URL=https://${checkoutUrl}; fi`
                );
            }
        } else {
            command.push(
                'if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                    `then export SCM_URL=${sshCheckoutUrl}; ` +
                    'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                    `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
                    `else export SCM_URL=https://${checkoutUrl}; fi`
            );
        }
        command.push(
            'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; ' +
                `then ${gitWrapper} ` +
                `"git clone $GIT_SPARSE_OPTION $GIT_RECURSIVE_OPTION --quiet --progress --branch '${branch}' ` +
                '$SCM_URL $SD_SOURCE_DIR"; ' +
                `else ${gitWrapper} ` +
                '"git clone $GIT_SPARSE_OPTION --depth=50 --no-single-branch $GIT_RECURSIVE_OPTION --quiet --progress ' +
                `--branch '${branch}' $SCM_URL $SD_SOURCE_DIR"; fi`
        );

        // Sparse Checkout
        command.push(
            'if [ ! -z "$GIT_SPARSE_CHECKOUT_PATH" ];' +
                'then $SD_GIT_WRAPPER "git sparse-checkout set $GIT_SPARSE_CHECKOUT_PATH" && ' +
                '$SD_GIT_WRAPPER "git checkout"; fi'
        );

        // Reset to Sha
        command.push(`echo 'Reset to SHA ${checkoutRef}'`);
        command.push(`${gitWrapper} "git reset --hard '${checkoutRef}'"`);

        // Set config
        command.push('echo Setting user name and user email');
        command.push(`${gitWrapper} "git config user.name ${this.config.username}"`);
        command.push(`${gitWrapper} "git config user.email ${this.config.email}"`);

        if (prReference) {
            const prRef = prReference.replace('merge', 'head:pr');

            command.push(`echo 'Fetching PR and merging with ${branch}'`);
            command.push(`${gitWrapper} "git fetch origin ${prRef}"`);
            command.push(`${gitWrapper} "git merge --no-edit ${sha}"`);
            // Init & Update submodule
            command.push(
                'if [ ! -z $GIT_RECURSIVE_CLONE ] && [ $GIT_RECURSIVE_CLONE = false ]; ' +
                    `then ${gitWrapper} "git submodule init"; ` +
                    `else ${gitWrapper} "git submodule update --init --recursive"; fi`
            );
        }

        // cd into rootDir after merging
        if (rootDir) {
            command.push(`cd ${rootDir}`);
        }

        return Promise.resolve({ name: 'sd-checkout-code', command: command.join(' && ') });
    }

    /**
     * Get list of objects (each consists of opened PR name and ref (branch)) of a pipeline
     * @async getOpenedPRs
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get opened PRs
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @return {Promise}
     */
    async _getOpenedPRs({ scmUri }) {
        const { repoId } = getScmUriParts(scmUri);
        const token = await this._getToken();

        try {
            const response = await this.breaker.runCommand({
                url: `${REPO_URL}/${repoId}/pullrequests`,
                method: 'GET',
                token
            });

            const prList = response.body.values;

            return prList.map(pr => ({
                name: `PR-${pr.id}`,
                ref: pr.source.branch.name
            }));
        } catch (err) {
            logger.error('Failed to getOpenedPRs: ', err);
            throw err;
        }
    }

    /**
     * Resolve a pull request object based on the config
     * @async getPrRef
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @return {Promise}
     */
    async _getPrInfo({ scmUri, prNum }) {
        const { repoId } = getScmUriParts(scmUri);
        const token = await this._getToken();

        try {
            const response = await this.breaker.runCommand({
                url: `${REPO_URL}/${repoId}/pullrequests/${prNum}`,
                method: 'GET',
                token
            });
            const pr = response.body;

            return {
                name: `PR-${pr.id}`,
                ref: pr.source.branch.name,
                sha: pr.source.commit.hash,
                url: pr.links.html.href,
                baseBranch: pr.source.branch.name
            };
        } catch (err) {
            logger.error('Failed to getPrInfo: ', err);
            throw err;
        }
    }

    /**
     * Retrieve stats for the scm
     * @method stats
     * @param  {Response}    Object          Object containing stats for the scm
     */
    stats() {
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];
        const stats = this.breaker.stats();

        return { [scmContext]: stats };
    }

    /**
     * Get an array of scm context (e.g. bitbucket:bitbucket.org)
     * @method getScmContexts
     * @return {Array}
     */
    _getScmContexts() {
        const contextName = [`bitbucket:${this.hostname}`];

        return contextName;
    }

    /**
     * Determine if a scm module can handle the received webhook
     * @method canHandleWebhook
     * @param  {Object}    headers     The request headers associated with the webhook payload
     * @param  {Object}    payload     The webhook payload received from the SCM service
     * @return {Promise}
     */
    _canHandleWebhook(headers, payload) {
        return this._parseHook(headers, payload)
            .then(() => Promise.resolve(true))
            .catch(err => {
                logger.error('Failed to run canHandleWebhook', err);

                return Promise.resolve(false);
            });
    }

    /**
     * Look up a branches from a repo
     * @async  _findBranches
     * @param  {Object}     config
     * @param  {String}     config.repoId       The bitbucket repo ID (e.g., "username/repoSlug")
     * @param  {String}     config.token        Admin Oauth2 token for the repo
     * @param  {Number}     config.page         pagination: page number to search next. 1-index.
     * @return {Promise}                        Resolves to a list of branches
     */
    async _findBranches(config) {
        const token = await this._getToken();

        try {
            const response = await this.breaker.runCommand({
                method: 'GET',
                token,
                url: `${REPO_URL}/${config.repoId}/refs/branches?pagelen=${BRANCH_PAGE_SIZE}&page=${config.page}`
            });

            let branches = hoek.reach(response, 'body.values');

            if (branches.length === BRANCH_PAGE_SIZE) {
                config.page += 1;
                const nextPageBranches = await this._findBranches(config);

                branches = branches.concat(nextPageBranches);
            }

            return branches.map(branch => ({ name: hoek.reach(branch, 'name') }));
        } catch (err) {
            logger.error('Failed to findBranches: ', err);
            throw err;
        }
    }

    /**
     * Get branch list from the Bitbucket repository
     * @async  _getBranchList
     * @param  {Object}     config
     * @param  {String}     config.scmUri      The SCM URI to get branch list
     * @param  {String}     config.token       Service token to authenticate with Bitbucket
     * @return {Promise}                       Resolves when complete
     */
    async _getBranchList({ scmUri, token }) {
        const repoInfo = getScmUriParts(scmUri);

        return this._findBranches({
            repoId: repoInfo.repoId,
            page: 1,
            token
        });
    }

    /**
     * Grab the current access token.  Ensures that if one is not yet available, a valid one is requested
     * @method _getToken
     * @return {Promise}
     */
    async _getToken() {
        // make sure our token is not yet expire. we will allow a 5s buffer in case there is a discrepency
        // in the time of our system and bitbucket or to account for in network time
        if (this.expiresIn < new Date().getTime() - 5000) {
            // time to refresh the token to get a new token
            await this._refreshToken();
        }

        return this.token;
    }

    /**
     * Refresh the access token to avoid token expiration.  Bitbucket token only lasts for 1-2 hours.
     * Will generate a new access token if one was not available yet
     * @async _refreshToken
     * @return {Promise}
     */
    async _refreshToken() {
        const params = {
            method: 'POST',
            username: this.config.oauthClientId,
            password: this.config.oauthClientSecret,
            url: `https://${this.hostname}/site/oauth2/access_token`,
            form: {}
        };

        // we will have to request for a new token if one is not yet generated
        if (this.token === '') {
            params.form = {
                grant_type: 'client_credentials'
            };
        } else {
            params.form = {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken
            };
        }

        try {
            const { body } = await this.breaker.runCommand(params);

            this.token = body.access_token;
            this.refreshToken = body.refresh_token;
            // convert the expires in to a microsecond timestamp from a # of seconds value
            this.expiresIn = new Date().getTime() + body.expires_in * 1000;
        } catch (err) {
            logger.error('Failed to refreshToken: ', err);
            throw err;
        }
    }
}

module.exports = BitbucketScm;
