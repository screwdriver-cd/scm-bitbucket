/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Fusebox = require('circuit-fuses');
const Scm = require('screwdriver-scm-base');
const hoek = require('hoek');
const joi = require('joi');
const url = require('url');
const request = require('request');
const schema = require('screwdriver-data-schema');
const API_URL_V1 = 'https://api.bitbucket.org/1.0';
const API_URL_V2 = 'https://api.bitbucket.org/2.0';
const REPO_URL = `${API_URL_V2}/repositories`;
const USER_URL = `${API_URL_V2}/users`;
const MATCH_COMPONENT_HOSTNAME = 1;
const MATCH_COMPONENT_USER = 2;
const MATCH_COMPONENT_REPO = 3;
const MATCH_COMPONENT_BRANCH = 4;
const STATE_MAP = {
    SUCCESS: 'SUCCESSFUL',
    RUNNING: 'INPROGRESS',
    QUEUED: 'INPROGRESS',
    FAILURE: 'FAILED',
    ABORTED: 'STOPPED'
};
const WEBHOOK_PAGE_SIZE = 30;

/**
 * Check the status code of the server's response.
 *
 * If there was an error encountered with the request, this will format a human-readable
 * error message.
 * @method checkResponseError
 * @param  {HTTPResponse}   response                               HTTP Response from `request` call
 * @param  {Number}         response.statusCode                    HTTP status code of the HTTP request
 * @param  {String}         [response.body.error.message]          Error message from the server
 * @param  {String}         [response.body.error.detail.required]  Error resolution message
 * @return {Promise}                                               Resolves when no error encountered.
 *                                                                 Rejects when status code is non-200
 */
function checkResponseError(response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
    }

    const errorMessage = hoek.reach(response, 'body.error.message', {
        default: `SCM service unavailable (${response.statusCode}).`
    });
    const errorReason = hoek.reach(response, 'body.error.detail.required', {
        default: JSON.stringify(response.body)
    });

    throw new Error(`${errorMessage} Reason "${errorReason}"`);
}

/**
 * Get repo information
 * @method  getRepoInfo
 * @param   {String}    checkoutUrl     The url to check out repo
 * @return  {Object}                    An object with hostname, repo, branch, and username
 */
function getRepoInfo(checkoutUrl) {
    const regex = schema.config.regex.CHECKOUT_URL;
    const matched = regex.exec(checkoutUrl);

    return {
        hostname: matched[MATCH_COMPONENT_HOSTNAME],
        repo: matched[MATCH_COMPONENT_REPO],
        branch: matched[MATCH_COMPONENT_BRANCH].slice(1),
        username: matched[MATCH_COMPONENT_USER]
    };
}

/**
 * Get hostname, repoId, and branch from scmUri
 * @method getScmUriParts
 * @param  {String}     scmUri
 * @return {Object}
 */
function getScmUriParts(scmUri) {
    const scm = {};

    [scm.hostname, scm.repoId, scm.branch] = scmUri.split(':');

    return scm;
}

class BitbucketScm extends Scm {
    /**
     * Constructor for Scm
     * @method constructor
     * @param  {String}  options.oauthClientId       OAuth Client ID provided by Bitbucket application
     * @param  {String}  options.oauthClientSecret   OAuth Client Secret provided by Bitbucket application
     * @param  {String}  [options.username=sd-buildbot]           Bitbucket username for checkout
     * @param  {String}  [options.email=dev-null@screwdriver.cd]  Bitbucket user email for checkout
     * @param  {Boolean} [options.https=false]       Is the Screwdriver API running over HTTPS
     * @param  {Object}  [options.fusebox={}]        Circuit Breaker configuration
     * @return {BitbucketScm}
     */
    constructor(config = {}) {
        super();

        this.config = joi.attempt(config, joi.object().keys({
            username: joi.string().optional().default('sd-buildbot'),
            email: joi.string().optional().default('dev-null@screwdriver.cd'),
            https: joi.boolean().optional().default(false),
            oauthClientId: joi.string().required(),
            oauthClientSecret: joi.string().required(),
            fusebox: joi.object().default({})
        }).unknown(true), 'Invalid config for Bitbucket');

        this.breaker = new Fusebox(request, this.config.fusebox);

        // TODO: set fixed value temporarily.
        // need to change if the other bitbucket host is supported.
        this.hostname = 'bitbucket.org';
    }

    /**
     * Look for a specific webhook that is attached to a repo.
     *
     * Searches through the webhook pages until the given webhook URL is found. If nothing is found, this will
     * return nothing. If a status response of non-200 is encountered, the chain is rejected with the
     * HTTP operation and the status code received.
     * @method _findWebhook
     * @param  {Object}     config
     * @param  {Number}     config.page    pagination: page number to search next. 1-index.
     * @param  {String}     config.repoId  The bitbucket repo ID (e.g., "username/repoSlug")
     * @param  {String}     config.token   Admin Oauth2 token for the repo
     * @param  {String}     config.url     url for webhook notifications
     * @return {Promise}                   Resolves to a webhook information payload
     */
    _findWebhook(config) {
        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${API_URL_V2}/repositories/${config.repoId}/hooks?pagelen=30&page=${config.page}`
        }).then((response) => {
            checkResponseError(response);

            const hooks = response.body;
            const result = hooks.values.find(webhook => webhook.url === config.url);

            if (!result && hooks.size >= WEBHOOK_PAGE_SIZE) {
                return this._findWebhook({
                    page: config.page + 1,
                    repoId: config.repoId,
                    token: config.token,
                    url: config.url
                });
            }

            return result;
        });
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
     * @return {Promise}                        Resolves when complete
     */
    _createWebhook(config) {
        const params = {
            body: {
                description: 'Screwdriver-CD build trigger',
                url: config.url,
                active: true,
                events: [
                    'repo:push',
                    'pullrequest:created',
                    'pullrequest:fulfilled',
                    'pullrequest:rejected',
                    'pullrequest:updated'
                ]
            },
            json: true,
            method: 'POST',
            auth: {
                bearer: config.token
            },
            url: `${API_URL_V2}/repositories/${config.repoId}/hooks`
        };

        if (config.hookInfo) {
            params.url = `${params.url}/${config.hookInfo.uuid}`;
            params.method = 'PUT';
        }

        return this.breaker.runCommand(params)
        .then(checkResponseError);
    }

    /**
     * Adds the Screwdriver webhook to the Bitbucket repository
     *
     * By default, it will attach the webhook to the repository. If the webhook URL already exists, then it
     * is instead updated.
     * @method _addWebhook
     * @param  {Object}    config
     * @param  {String}    config.scmUri  The SCM URI to add the webhook to
     * @param  {String}    config.token   Oauth2 token to authenticate with Bitbucket
     * @param  {String}    config.url     The URL to use for webhook notifications
     * @return {Promise}                  Resolves upon success
     */
    _addWebhook(config) {
        const repoInfo = getScmUriParts(config.scmUri);

        return this._findWebhook({
            page: 1,
            repoId: repoInfo.repoId,
            token: config.token,
            url: config.url
        })
        .then(hookInfo =>
            this._createWebhook({
                hookInfo,
                repoId: repoInfo.repoId,
                token: config.token,
                url: config.url
            })
        );
    }

    /**
     * Parse the url for a repo for the specific source control
     * @method parseUrl
     * @param  {Object}    config
     * @param  {String}    config.checkoutUrl   Url to parse
     * @param  {String}    config.token         The token used to authenticate to the SCM
     * @return {Promise}                        Resolves to scmUri
     */
    _parseUrl(config) {
        const repoInfo = getRepoInfo(config.checkoutUrl);
        const branchUrl =
            `${REPO_URL}/${repoInfo.username}/${repoInfo.repo}/refs/branches/${repoInfo.branch}`;
        const options = {
            url: branchUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        if (repoInfo.hostname !== this.hostname) {
            throw new Error(
                'This checkoutUrl is not supported for your current login host.');
        }

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode === 404) {
                    throw new Error(`Cannot find repository ${config.checkoutUrl}`);
                }
                if (response.statusCode !== 200) {
                    throw new Error(
                        `STATUS CODE ${response.statusCode}: ${JSON.stringify(response.body)}`);
                }

                return `${repoInfo.hostname}:${repoInfo.username}` +
                    `/${response.body.target.repository.uuid}:${repoInfo.branch}`;
            });
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @method parseHook
     * @param  {Object}  headers  The request headers associated with the webhook payload
     * @param  {Object}  payload  The webhook payload received from the SCM service.
     * @return {Object}           A key-map of data related to the received payload
     */
    _parseHook(headers, payload) {
        const [typeHeader, actionHeader] = headers['x-event-key'].split(':');
        const parsed = {};
        const repoOwner = hoek.reach(payload, 'repository.owner.username');
        const scmContexts = this._getScmContexts();

        parsed.hookId = headers['x-request-uuid'];
        parsed.scmContext = scmContexts[0];

        switch (typeHeader) {
        case 'repo': {
            if (actionHeader !== 'push') {
                return Promise.resolve(null);
            }
            const changes = hoek.reach(payload, 'push.changes');
            const link = url.parse(hoek.reach(payload, 'repository.links.html.href'));

            parsed.type = 'repo';
            parsed.action = 'push';
            parsed.username = hoek.reach(payload, 'actor.username');
            parsed.checkoutUrl = `${link.protocol}//${repoOwner}`
                + `@${link.hostname}${link.pathname}.git`;
            parsed.branch = hoek.reach(changes[0], 'new.name');
            parsed.sha = hoek.reach(changes[0], 'new.target.hash');
            parsed.lastCommitMessage = hoek.reach(changes[0], 'new.target.message',
                { default: '' });

            return Promise.resolve(parsed);
        }
        case 'pullrequest': {
            if (actionHeader === 'created') {
                parsed.action = 'opened';
            } else if (actionHeader === 'updated') {
                parsed.action = 'synchronized';
            } else if (actionHeader === 'fullfilled' || actionHeader === 'rejected') {
                parsed.action = 'closed';
            } else {
                return Promise.resolve(null);
            }

            const link = url.parse(hoek.reach(payload, 'repository.links.html.href'));

            parsed.type = 'pr';
            parsed.username = hoek.reach(payload, 'actor.username');
            parsed.checkoutUrl = `${link.protocol}//${repoOwner}`
                + `@${link.hostname}${link.pathname}.git`;
            parsed.branch = hoek.reach(payload, 'pullrequest.destination.branch.name');
            parsed.sha = hoek.reach(payload, 'pullrequest.source.commit.hash');
            parsed.prNum = hoek.reach(payload, 'pullrequest.id');
            parsed.prRef = hoek.reach(payload, 'pullrequest.source.branch.name');

            return Promise.resolve(parsed);
        }
        default:
            return Promise.resolve(null);
        }
    }

    /**
     * Decorate the author based on the Bitbucket
     * @method _decorateAuthor
     * @param  {Object}        config          Configuration object
     * @param  {Object}        config.token    Access token to authenticate with Bitbucket
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}                       Resolves to a decorated author with url, name, username, avatar
     */
    _decorateAuthor(config) {
        const options = {
            url: `${USER_URL}/${config.username}`,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = response.body;

                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${JSON.stringify(body)}`);
                }

                return {
                    url: body.links.html.href,
                    name: body.display_name,
                    username: body.username,
                    avatar: body.links.avatar.href
                };
            });
    }

   /**
    * Decorate a given SCM URI with additional data to better display
    * related information. If a branch suffix is not provided, it will default
    * to the master branch
    * @method decorateUrl
    * @param  {Config}    config         Configuration object
    * @param  {String}    config.scmUri  The scmUri
    * @param  {String}    config.token   Service token to authenticate with Bitbucket
    * @return {Object}                   Resolves to a decoratedUrl with url, name, and branch
    */
    _decorateUrl(config) {
        const scm = getScmUriParts(config.scmUri);
        const options = {
            url: `${REPO_URL}/${scm.repoId}`,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = response.body;

                if (response.statusCode !== 200) {
                    throw new Error(
                        `STATUS CODE ${response.statusCode}: ${JSON.stringify(body)}`);
                }

                return {
                    url: body.links.html.href,
                    name: body.full_name,
                    branch: scm.branch
                };
            });
    }

    /**
     * Decorate the commit based on the repository
     * @method _decorateCommit
     * @param  {Object}     config           Configuration object
     * @param  {Object}     config.sha       Commit sha to decorate
     * @param  {Object}     config.scmUri    The scmUri that the commit belongs to
     * @param  {Object}     config.token     Service token to authenticate with Bitbucket
     * @return {Promise}                     Resolves to a decorated object with url, message, and author
     */
    _decorateCommit(config) {
        const scm = getScmUriParts(config.scmUri);
        const options = {
            url: `${REPO_URL}/${scm.repoId}/commit/${config.sha}`,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = response.body;

                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${JSON.stringify(body)}`);
                }

                // eslint-disable-next-line
                return this._decorateAuthor({
                    username: body.author.user.username,
                    token: config.token
                }).then(author => ({
                    url: body.links.html.href,
                    message: body.message,
                    author
                }));
            });
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @method getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  [config.prNum]    The PR number used to fetch the PR
     * @return {Promise}                    Resolves to the sha for the scmUri
     */
    _getCommitSha(config) {
        if (config.prNum) {
            return this._getPrInfo(config).then(pr => pr.sha);
        }

        const scm = getScmUriParts(config.scmUri);
        const branchUrl =
            `${REPO_URL}/${scm.repoId}/refs/branches/${scm.branch}`;
        const options = {
            url: branchUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(
                        `STATUS CODE ${response.statusCode}: ${JSON.stringify(response.body)}`);
                }

                return response.body.target.hash;
            });
    }

    /**
     * Fetch content of a file from Bitbucket
     * @method getFile
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri
     * @param  {String}   config.path         The file in the repo to fetch
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   [config.ref]        The reference to the SCM, either branch or sha
     * @return {Promise}                      Resolves to the content of the file
     */
    _getFile(config) {
        const scm = getScmUriParts(config.scmUri);
        const branch = config.ref || scm.branch;
        const fileUrl = `${API_URL_V1}/repositories/${scm.repoId}/src/${branch}/${config.path}`;
        const options = {
            url: fileUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(
                        `STATUS CODE ${response.statusCode}: ${JSON.stringify(response.body)}`);
                }

                return response.body.data;
            });
    }

    /**
     * Get a user's permissions on a repository
     * @method _getPermissions
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}                    Resolves to permissions object with admin, push, pull
     */
    _getPermissions(config) {
        const scm = getScmUriParts(config.scmUri);
        const getPerm = (repoId, desiredAccess, token) => {
            const [owner, uuid] = repoId.split('/');
            const options = {
                url: `${API_URL_V2}/repositories/${owner}`,
                method: 'GET',
                json: true,
                auth: {
                    bearer: token
                }
            };

            if (desiredAccess === 'admin') {
                options.url = `${options.url}?role=admin`;
            } else if (desiredAccess === 'push') {
                options.url = `${options.url}?role=contributor`;
            } else {
                options.url = `${options.url}`;
            }

            return this.breaker.runCommand(options)
                .then((response) => {
                    if (response.statusCode !== 200) {
                        throw new Error(
                            `STATUS CODE ${response.statusCode}: ${JSON.stringify(response.body)}`);
                    }

                    return response.body.values.some(r => r.uuid === uuid);
                });
        };

        return Promise.all([
            getPerm(scm.repoId, 'admin', config.token),
            getPerm(scm.repoId, 'push', config.token),
            getPerm(scm.repoId, 'pull', config.token)
        ]).then(([admin, push, pull]) => ({
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
    _updateCommitStatus(config) {
        const scm = getScmUriParts(config.scmUri);
        let context = `Screwdriver/${config.pipelineId}/`;

        context += /^PR/.test(config.jobName) ? 'PR' : config.jobName;

        const options = {
            url: `${REPO_URL}/${scm.repoId}/commit/${config.sha}/statuses/build`,
            method: 'POST',
            json: true,
            body: {
                url: config.url,
                state: STATE_MAP[config.buildStatus],
                key: config.sha,
                description: context
            },
            auth: {
                bearer: decodeURIComponent(config.token)
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 201 && response.statusCode !== 200) {
                    throw new Error(
                        `STATUS CODE ${response.statusCode}: ${JSON.stringify(response.body)}`);
                }

                return response;
            });
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
    * @param  {String}    config.branch        Pipeline branch
    * @param  {String}    config.host          Scm host to checkout source code from
    * @param  {String}    config.org           Scm org name
    * @param  {String}    config.repo          Scm repo name
    * @param  {String}    config.sha           Commit sha
    * @param  {String}    [config.prRef]       PR reference (can be a PR branch or reference)
    * @return {Promise}
    */
    _getCheckoutCommand(config) {
        const checkoutUrl = `${config.host}/${config.org}/${config.repo}`;
        const sshCheckoutUrl = `git@${config.host}:${config.org}/${config.repo}`;
        const checkoutRef = config.prRef ? config.branch : config.sha;
        const gitWrapper = '$(if git --version > /dev/null 2>&1; ' +
            "then echo 'eval'; " +
            "else echo 'sd-step exec core/git'; fi)";
        const command = [];

        // Git clone
        command.push(`echo Cloning ${checkoutUrl}, on branch ${config.branch}`);
        command.push('if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
            `then export SCM_URL=${sshCheckoutUrl}; ` +
            'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
            `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
            `else export SCM_URL=https://${checkoutUrl}; fi`
        );
        command.push(`${gitWrapper} `
            + `"git clone --quiet --progress --branch ${config.branch} $SCM_URL $SD_SOURCE_DIR"`);
        // Reset to Sha
        command.push(`echo Reset to SHA ${checkoutRef}`);
        command.push(`${gitWrapper} "git reset --hard ${checkoutRef}"`);

        // Set config
        command.push('echo Setting user name and user email');
        command.push(`${gitWrapper} "git config user.name ${this.config.username}"`);
        command.push(`${gitWrapper} "git config user.email ${this.config.email}"`);

        if (config.prRef) {
            const prRef = config.prRef.replace('merge', 'head:pr');

            command.push(`echo Fetching PR and merging with ${config.branch}`);
            command.push(`${gitWrapper} "git fetch origin ${prRef}"`);
            command.push(`${gitWrapper} "git merge --no-edit ${config.sha}"`);
        }

        return Promise.resolve({ name: 'sd-checkout-code', command: command.join(' && ') });
    }

    /**
    * Get list of objects (each consists of opened PR name and ref (branch)) of a pipeline
    * @method getOpenedPRs
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get opened PRs
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getOpenedPRs(config) {
        const repoId = getScmUriParts(config.scmUri).repoId;

        return this.breaker.runCommand({
            url: `${API_URL_V2}/repositories/${repoId}/pullrequests`,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        }).then((response) => {
            checkResponseError(response);

            const prList = response.body.values;

            return prList.map(pr => ({
                name: `PR-${pr.id}`,
                ref: pr.source.branch.name
            }));
        });
    }

    /**
    * Resolve a pull request object based on the config
    * @method getPrRef
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get PR info of
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @param  {Integer}  config.prNum      The PR number used to fetch the PR
    * @return {Promise}
    */
    _getPrInfo(config) {
        const repoId = getScmUriParts(config.scmUri).repoId;

        return this.breaker.runCommand({
            url: `${API_URL_V2}/repositories/${repoId}/pullrequests/${config.prNum}`,
            method: 'GET',
            json: true,
            auth: {
                bearer: config.token
            }
        }).then((response) => {
            checkResponseError(response);

            const pr = response.body;

            return {
                name: `PR-${pr.id}`,
                ref: pr.source.branch.name,
                sha: pr.source.commit.hash
            };
        });
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
    * @param {Object}    headers     The request headers associated with the webhook payload
    * @param {Object}    payload     The webhook payload received from the SCM service
    * @return {Promise}
    * */
    _canHandleWebhook(headers, payload) {
        return this._parseHook(headers, payload).then((parseResult) => {
            if (parseResult === null) {
                return Promise.resolve(false);
            }

            const [, checkoutUrlHost] = parseResult.checkoutUrl.split('@');

            return Promise.resolve(checkoutUrlHost.startsWith(this.hostname));
        }).catch(() => (
            Promise.resolve(false)
        ));
    }
}

module.exports = BitbucketScm;
