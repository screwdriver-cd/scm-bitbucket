'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');
const testPayloadOpen = require('./data/pr.opened.json');
const testPayloadClose = require('./data/pr.closed.json');
const testPayloadPush = require('./data/repo.push.json');
const token = 'myAccessToken';
const API_URL_V1 = 'https://api.bitbucket.org/1.0';
const API_URL_V2 = 'https://api.bitbucket.org/2.0';

require('sinon-as-promised');
sinon.assert.expose(assert, { prefix: '' });

describe('index', () => {
    let BitbucketScm;
    let scm;
    let requestMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub();
        mockery.registerMock('request', requestMock);

        /* eslint-disable global-require */
        BitbucketScm = require('../index');
        /* eslint-enable global-require */

        scm = new BitbucketScm({
            fusebox: {
                retry: {
                    minTimeout: 1
                }
            },
            oauthClientId: 'myclientid',
            oauthClientSecret: 'myclientsecret'
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('constructor', () => {
        it('validates input', () => {
            try {
                scm = new BitbucketScm();
                assert.fail('should not get here');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.equal(err.name, 'ValidationError');
            }
        });
        it('constructs successfully', () => {
            const testScm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret'
            });

            assert.deepEqual(testScm.config, {
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                fusebox: {},
                https: false
            });
        });
    });

    describe('parseUrl', () => {
        const apiUrl = `${API_URL_V2}/repositories/batman/test/refs/branches`;
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    repository: {
                        html: {
                            href: 'https://bitbucket.org/batman/test'
                        },
                        type: 'repository',
                        name: 'test',
                        full_name: 'batman/test',
                        uuid: '{de7d7695-1196-46a1-b87d-371b7b2945ab}'
                    }
                }
            };
            expectedOptions = {
                url: `${apiUrl}/mynewbranch`,
                method: 'GET',
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to the correct parsed url for ssh', () => {
            const expected =
                'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:master';

            expectedOptions = {
                url: `${apiUrl}/master`,
                method: 'GET',
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };

            return scm.parseUrl({
                checkoutUrl: 'git@bitbucket.org:batman/test.git#master',
                token
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('resolves to the correct parsed url for https', () => {
            const expected =
                'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:mynewbranch';

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('rejects if request fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(error, err);
                });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, 'STATUS CODE 404');
                });
        });
    });

    describe('parseHook', () => {
        it('returns the correct parsed config for opened PR', () => {
            const expected = {
                type: 'pr',
                action: 'opened',
                username: 'batman',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'pullrequest:created',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadOpen)
                .then(result => assert.deepEqual(result, expected));
        });

        it('returns the correct parsed config for closed PR', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'batman',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'pullrequest:fullfilled',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('returns the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: 'batman',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
                branch: 'stuff',
                sha: '9ff49b2d1437567cad2b5fed7a0706472131e927',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'repo:push',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadPush)
                .then(result => assert.deepEqual(result, expected));
        });

        it('throws error if events are not supported: repoFork', () => {
            const repoFork = {
                'x-event-key': 'repo:fork'
            };

            return scm.parseHook(repoFork, {})
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.deepEqual(error.message,
                        'Only push event is supported for repository');
                });
        });

        it('throws error if events are not supported: prComment', () => {
            const prComment = {
                'x-event-key': 'pullrequest:comment_created'
            };

            return scm.parseHook(prComment, {})
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.deepEqual(error.message,
                        'Only created and fullfilled events are supported for pullrequest');
                });
        });

        it('throws error if events are not supported: issueCreated', () => {
            const issueCreated = {
                'x-event-key': 'issue:created'
            };

            return scm.parseHook(issueCreated, {})
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.deepEqual(error.message,
                        'Only repository and pullrequest events are supported');
                });
        });
    });

    describe('decorateAuthor', () => {
        const apiUrl = `${API_URL_V2}/users/batman`;
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    username: 'batman',
                    display_name: 'Batman',
                    uuid: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/batman/'
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/batman/avatar/32/'
                        }
                    }
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated author', () => {
            const expected = {
                url: 'https://bitbucket.org/batman/',
                name: 'Batman',
                username: 'batman',
                avatar: 'https://bitbucket.org/account/batman/avatar/32/'
            };

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateUrl', () => {
        const apiUrl = `${API_URL_V2}/repositories/batman/{1234}`;
        const selfLink = 'https://bitbucket.org/d2lam2/test';
        const repoOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    full_name: 'batman/mybranch',
                    links: {
                        html: {
                            href: selfLink
                        }
                    }
                }
            };
            expectedOptions = {
                url: apiUrl,
                method: 'GET',
                json: true,
                auth: {
                    bearer: token
                }
            };
            requestMock.withArgs(repoOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated url object', () => {
            const expected = {
                url: selfLink,
                name: 'batman/mybranch',
                branch: 'mybranch'
            };

            return scm.decorateUrl({
                scmUri: 'bitbucket.org:batman/{1234}:mybranch',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateUrl({
                scmUri: 'bitbucket.org:batman/{1234}:mybranch',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).yieldsAsync(err);

            return scm.decorateUrl({
                scmUri: 'bitbucket.org:batman/{1234}:mybranch',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateCommit', () => {
        const repoUrl =
            `${API_URL_V2}/repositories/batman/{1234}/commit/40171b678527`;
        const authorUrl = `${API_URL_V2}/users/batman`;
        const selfLink = 'https://bitbucket.org/batman/test/commits/40171b678527';
        const repoOptions = {
            url: repoUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const authorOptions = {
            url: authorUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;
        let fakeAuthorResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    message: 'testing',
                    links: {
                        html: {
                            href: selfLink
                        }
                    },
                    author: {
                        user: {
                            username: 'batman'
                        }
                    }
                }
            };
            fakeAuthorResponse = {
                statusCode: 200,
                body: {
                    username: 'batman',
                    display_name: 'Batman',
                    uuid: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/batman/'
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/batman/avatar/32/'
                        }
                    }
                }
            };
            requestMock.withArgs(repoOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
            requestMock.withArgs(authorOptions)
                .yieldsAsync(null, fakeAuthorResponse, fakeAuthorResponse.body);
        });

        it('resolves to correct decorated object', () => {
            const expected = {
                url: selfLink,
                message: 'testing',
                author: {
                    url: 'https://bitbucket.org/batman/',
                    name: 'Batman',
                    username: 'batman',
                    avatar: 'https://bitbucket.org/account/batman/avatar/32/'
                }
            };

            return scm.decorateCommit({
                sha: '40171b678527',
                scmUri: 'bitbucket.org:batman/{1234}:test',
                token
            }).then((decorated) => {
                assert.calledTwice(requestMock);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateCommit({
                sha: '40171b678527',
                scmUri: 'bitbucket.org:batman/{1234}:test',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledOnce(requestMock);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).yieldsAsync(err);

            return scm.decorateCommit({
                sha: '40171b678527',
                scmUri: 'bitbucket.org:batman/{1234}:test',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('getCommitSha', () => {
        const apiUrl =
            `${API_URL_V2}/repositories/batman/{1234}/refs/branches/mybranch`;
        const scmUri = 'bitbucket.org:batman/{1234}:mybranch';
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    target: {
                        hash: 'b98ff332acceca6c477ccd7718b2efa8c67999bb'
                    }
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha', () =>
            scm.getCommitSha({
                scmUri,
                token
            }).then((sha) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(sha, 'b98ff332acceca6c477ccd7718b2efa8c67999bb');
            })
        );

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getFile', () => {
        const apiUrl = `${API_URL_V1}/repositories/batman/{1234}/src/mybranch/testFile.txt`;
        const scmUri = 'bitbucket.org:batman/{1234}:mybranch';
        const params = {
            scmUri,
            token,
            path: 'testFile.txt'
        };
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    node: '25e63fb4ee8a',
                    path: 'testFile.txt',
                    data: 'THIS IS A TEST',
                    size: 14
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha', () =>
            scm.getFile(params).then((content) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'THIS IS A TEST');
            })
        );

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getPermissions', () => {
        const pull = {
            url: `${API_URL_V2}/repositories/batman`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const push = {
            url: `${API_URL_V2}/repositories/batman?role=contributor`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const admin = {
            url: `${API_URL_V2}/repositories/batman?role=admin`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const readResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: '{repo1}' },
                    { uuid: '{repo2}' },
                    { uuid: '{repo3}' }
                ]
            }
        };
        const writeResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: '{repo1}' },
                    { uuid: '{repo2}' }
                ]
            }
        };
        const adminResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: '{repo1}' }
                ]
            }
        };

        beforeEach(() => {
            requestMock.withArgs(pull).yieldsAsync(null, readResponse, readResponse.body);
            requestMock.withArgs(push).yieldsAsync(null, writeResponse, writeResponse.body);
            requestMock.withArgs(admin).yieldsAsync(null, adminResponse, adminResponse.body);
        });

        it('get correct admin permissions', () => {
            const scmUri = 'bitbucket.org:batman/{repo1}:mybranch';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.calledThrice(requestMock);
                assert.calledWith(requestMock, pull);
                assert.calledWith(requestMock, push);
                assert.calledWith(requestMock, admin);
                assert.deepEqual(permissions, {
                    admin: true,
                    push: true,
                    pull: true
                });
            });
        });

        it('get correct push permissions', () => {
            const scmUri = 'bitbucket.org:batman/{repo2}:mybranch';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.calledThrice(requestMock);
                assert.calledWith(requestMock, pull);
                assert.calledWith(requestMock, push);
                assert.calledWith(requestMock, admin);
                assert.deepEqual(permissions, {
                    admin: false,
                    push: true,
                    pull: true
                });
            });
        });

        it('get correct pull permissions', () => {
            const scmUri = 'bitbucket.org:batman/{repo3}:mybranch';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.deepEqual(permissions, {
                    admin: false,
                    push: false,
                    pull: true
                });
            });
        });

        it('no permissions', () => {
            const scmUri = 'bitbucket.org:batman/{repo4}:mybranch';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.deepEqual(permissions, {
                    admin: false,
                    push: false,
                    pull: false
                });
            });
        });

        it('rejects if status code is not 200', () => {
            const scmUri = 'bitbucket.org:batman/{repo5}:mybranch';
            const fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.withArgs(pull).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const error = new Error('Bitbucket API error');
            const scmUri = 'bitbucket.org:batman/{repo5}:mybranch';

            requestMock.withArgs(pull).yieldsAsync(error);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((err) => {
                assert.equal(error, err);
            });
        });
    });

    describe('updateCommitStatus', () => {
        let config;
        let apiUrl;
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            config = {
                scmUri: 'bitbucket.org:batman/{1234}:mybranch',
                sha: '40171b6785277ed1478ee2bc8587064e5a7d9fda',
                buildStatus: 'SUCCESS',
                token: 'sK6-nvoU%3D',
                url: 'https://cd.screwdriver.cd/pipelines/1234',
                jobName: 'main'
            };
            apiUrl = `${API_URL_V2}/repositories/batman/{1234}/commit/${config.sha}/statuses/build`;
            fakeResponse = {
                statusCode: 200
            };
            expectedOptions = {
                url: apiUrl,
                method: 'POST',
                json: true,
                body: {
                    url: config.url,
                    state: 'SUCCESSFUL',
                    key: config.sha,
                    description: 'Screwdriver/main'
                },
                auth: {
                    bearer: 'sK6-nvoU='     // Decoded access token
                }
            };
            requestMock.yieldsAsync(null, fakeResponse);
        });

        it('successfully update status', () =>
            scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            })
        );

        it('successfully update status with correct values', () => {
            config.buildStatus = 'ABORTED';
            delete config.jobName;

            expectedOptions.body.state = 'STOPPED';
            expectedOptions.body.description = 'Screwdriver';

            return scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 401,
                body: {
                    error: {
                        message: 'Access token expired'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 401');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getBellConfiguration', () => {
        it('returns a default configuration', () =>
            scm.getBellConfiguration().then((config) => {
                assert.deepEqual(config, {
                    clientId: 'myclientid',
                    clientSecret: 'myclientsecret',
                    forceHttps: false,
                    isSecure: false,
                    provider: 'bitbucket'
                });
            })
        );
    });

    describe('getWebhookStrategy', () => {
        it('returns null', () =>
            assert.isNull(scm.getWebhookStrategy())
        );
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(scm.stats(), {
                requests: {
                    total: 0,
                    timeouts: 0,
                    success: 0,
                    failure: 0,
                    concurrent: 0,
                    averageTime: 0
                },
                breaker: {
                    isClosed: true
                }
            });
        });
    });
});
