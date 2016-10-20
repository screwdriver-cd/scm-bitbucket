'use strict';

const Fusebox = require('circuit-fuses');
const Scm = require('screwdriver-scm-base');
const hoek = require('hoek');
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
     * @param  {Object}    config               Configuration
     * @param  {String}    [config.fusebox]     Options for the circuit breaker
     * @return {ScmBase}
     */
    constructor(config) {
        super(config);

        this.breaker = new Fusebox(request, config.fusebox);
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
        const branchUrl = `${REPO_URL}/${repoInfo.username}/${repoInfo.repo}` +
            `/refs/branches/${repoInfo.branch}?access_key=${config.token}`;
        const options = {
            url: branchUrl,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${response.body}`);
                }

                const uuid = JSON.parse(response.body).repository.uuid;

                return `${repoInfo.hostname}:${repoInfo.username}` +
                    `/${uuid}:${repoInfo.branch}`;
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
        const [typeHeader, actionHeader] = headers['X-Event-Key'].split(':');
        const parsed = {};

        switch (typeHeader) {
        case 'repo': {
            if (actionHeader !== 'push') {
                throw new Error('Only push event is supported for repository');
            }
            const changes = hoek.reach(payload, 'push.changes');
            const link = url.parse(hoek.reach(payload, 'repository.links.html.href'));

            parsed.type = 'repo';
            parsed.action = 'push';
            parsed.username = hoek.reach(payload, 'actor.username');
            parsed.checkoutUrl = `${link.protocol}//${parsed.username}`
                + `@${link.hostname}${link.pathname}.git`;
            parsed.branch = hoek.reach(changes[0], 'new.name');
            parsed.sha = hoek.reach(changes[0], 'new.target.hash');

            return parsed;
        }
        case 'pullrequest': {
            if (actionHeader === 'created') {
                parsed.action = 'opened';
            } else if (actionHeader === 'fullfilled') {
                parsed.action = 'closed';
            } else {
                throw new Error('Only created and fullfilled events are supported for pullrequest');
            }

            const link = url.parse(hoek.reach(payload, 'repository.links.html.href'));

            parsed.type = 'pr';
            parsed.username = hoek.reach(payload, 'pullrequest.author.username');
            parsed.checkoutUrl = `${link.protocol}//${parsed.username}`
                + `@${link.hostname}${link.pathname}.git`;
            parsed.branch = hoek.reach(payload, 'pullrequest.source.branch.name');
            parsed.sha = hoek.reach(payload, 'pullrequest.source.commit.hash');
            parsed.prNum = hoek.reach(payload, 'pullrequest.id');
            parsed.prRef = `refs/pull-request/${parsed.prNum}/from`;

            return parsed;
        }
        default:
            throw new Error('Only repository and pullrequest events are supported');
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
            url: `${USER_URL}/${config.username}?access_key=${config.token}`,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = JSON.parse(response.body);

                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${body}`);
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
            url: `${REPO_URL}/${scm.repoId}?access_key=${config.token}`,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = JSON.parse(response.body);

                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${body}`);
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
            url: `${REPO_URL}/${scm.repoId}/commit/${config.sha}?access_key=${config.token}`,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                const body = JSON.parse(response.body);

                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${body}`);
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
     * @return {Promise}                    Resolves to the sha for the scmUri
     */
    _getCommitSha(config) {
        const scm = getScmUriParts(config.scmUri);
        const branchUrl =
            `${REPO_URL}/${scm.repoId}/refs/branches/${scm.branch}?access_key=${config.token}`;
        const options = {
            url: branchUrl,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${response.body}`);
                }

                return JSON.parse(response.body).target.hash;
            });
    }

    /**
     * Fetch content of a file from Bitbucket
     * @method getFile
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri
     * @param  {String}   config.path         The file in the repo to fetch
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.ref          The reference to the SCM, either branch or sha
     * @return {Promise}                      Resolves to the content of the file
     */
    _getFile(config) {
        const scm = getScmUriParts(config.scmUri);
        const urlRoot = `${API_URL_V1}/repositories/${scm.repoId}`;
        const urlSuffix = `src/${config.ref}/${config.path}`;
        const urlParameters = `access_key=${config.token}`;
        const fileUrl = `${urlRoot}/${urlSuffix}?${urlParameters}`;
        const options = {
            url: fileUrl,
            method: 'GET'
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${response.body}`);
                }

                return JSON.parse(response.body).data;
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
                method: 'GET'
            };

            if (desiredAccess === 'admin') {
                options.url = `${options.url}?role=admin&access_key=${token}`;
            } else if (desiredAccess === 'push') {
                options.url = `${options.url}?role=contributor&access_key=${token}`;
            } else {
                options.url = `${options.url}?access_key=${token}`;
            }

            return this.breaker.runCommand(options)
                .then((response) => {
                    if (response.statusCode !== 200) {
                        throw new Error(`STATUS CODE ${response.statusCode}: ${response.body}`);
                    }

                    return JSON.parse(response.body).values.some(r => r.uuid === uuid);
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
     * @param  {String}   [config.jobName]    Optional name of the job that finished
     * @return {Promise}
     */
    _updateCommitStatus(config) {
        const scm = getScmUriParts(config.scmUri);
        const options = {
            url: `${REPO_URL}/${scm.repoId}/commit/${config.sha}/statuses/build`,
            method: 'POST',
            json: true,
            body: {
                url: config.url,
                state: STATE_MAP[config.buildStatus],
                key: config.sha,
                description: config.jobName ? `Screwdriver/${config.jobName}` : 'Screwdriver'
            },
            auth: {
                bearer: decodeURIComponent(config.token)
            }
        };

        return this.breaker.runCommand(options)
            .then((response) => {
                if (response.statusCode !== 200) {
                    throw new Error(`STATUS CODE ${response.statusCode}: ${response.body}`);
                }

                return response;
            });
    }

    /**
     * Retrieve stats for the scm
     * @method stats
     * @param  {Response}    Object          Object containing stats for the scm
     */
    stats() {
        return this.breaker.stats();
    }
}

module.exports = BitbucketScm;
