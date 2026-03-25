import type { DataSource } from "../../../src"
import { QueryFailedError } from "../../../src/error/QueryFailedError"
import {
    closeTestingConnections,
    createTestingConnections,
    reloadTestingDatabases,
} from "../../utils/test-utils"
import { Post } from "./entity/Post.js"
import { expect } from "chai"

describe("github issues > #9984 TransactionRetryWithProtoRefreshError should be handled by TypeORM", () => {
    describe("manual transactions (no retry)", () => {
        let dataSources: DataSource[]

        before(async () => {
            dataSources = await createTestingConnections({
                entities: [Post],
                enabledDrivers: ["cockroachdb"],
            })
        })

        beforeEach(() => reloadTestingDatabases(dataSources))
        after(() => closeTestingConnections(dataSources))

        it("should propagate 40001 error on manual transactions", () =>
            Promise.all(
                dataSources.map(async (dataSource) => {
                    const queryRunner = dataSource.createQueryRunner()
                    await dataSource.query(
                        "SET inject_retry_errors_enabled = true",
                    )
                    await queryRunner.startTransaction()

                    const post = new Post()
                    post.name = `post`

                    try {
                        await queryRunner.manager.save(post)
                        await queryRunner.commitTransaction()
                        expect.fail("Should have thrown a 40001 error")
                    } catch (err) {
                        expect(err).to.be.instanceOf(QueryFailedError)
                        expect((err as any).code).to.equal("40001")
                        try {
                            await queryRunner.rollbackTransaction()
                        } catch (_) {}
                    } finally {
                        await queryRunner.release()
                        await dataSource.query(
                            "SET inject_retry_errors_enabled = false",
                        )
                    }
                }),
            ))
    })

    describe("callback-based transactions with maxTransactionRetries > 0", () => {
        let dataSources: DataSource[]

        before(async () => {
            dataSources = await createTestingConnections({
                entities: [Post],
                enabledDrivers: ["cockroachdb"],
                driverSpecific: {
                    maxTransactionRetries: 5,
                },
            })
        })

        beforeEach(() => reloadTestingDatabases(dataSources))
        after(() => closeTestingConnections(dataSources))

        it("should retry callback-based transaction on 40001 error", () =>
            Promise.all(
                dataSources.map(async (dataSource) => {
                    await dataSource.query(
                        "SET inject_retry_errors_enabled = true",
                    )

                    let callbackCount = 0
                    const post = new Post()
                    post.name = "post"

                    await dataSource.manager.transaction(async (manager) => {
                        callbackCount++
                        await manager.save(post)
                    })

                    await dataSource.query(
                        "SET inject_retry_errors_enabled = false",
                    )

                    // Callback should have been invoked more than once due to retries
                    expect(callbackCount).to.be.greaterThan(1)

                    const loadedPost = await dataSource.manager.findOneBy(
                        Post,
                        { id: post.id },
                    )
                    expect(loadedPost).to.be.not.undefined
                }),
            ))

        it("should retry callback-based transaction on concurrent 40001 error", () =>
            Promise.all(
                dataSources.map(async (dataSource) => {
                    const post = new Post()
                    post.name = "post"
                    await dataSource.manager.save(post)

                    const query = async (name: string) => {
                        await dataSource.manager.transaction(
                            async (manager) => {
                                const updatedPost = new Post()
                                updatedPost.id = post.id
                                updatedPost.name = name
                                await manager.save(updatedPost)
                            },
                        )
                    }

                    await Promise.all(
                        [1, 2, 3].map((i) => query(`changed_${i}`)),
                    )

                    const loadedPost = await dataSource.manager.findOneByOrFail(
                        Post,
                        {
                            id: post.id,
                        },
                    )
                    expect(loadedPost.name).to.not.equal("post")
                }),
            ))
    })

    describe("callback-based transactions with default maxTransactionRetries (0)", () => {
        let dataSources: DataSource[]

        before(async () => {
            dataSources = await createTestingConnections({
                entities: [Post],
                enabledDrivers: ["cockroachdb"],
            })
        })

        beforeEach(() => reloadTestingDatabases(dataSources))
        after(() => closeTestingConnections(dataSources))

        it("should not retry when maxTransactionRetries defaults to 0", () =>
            Promise.all(
                dataSources.map(async (dataSource) => {
                    await dataSource.query(
                        "SET inject_retry_errors_enabled = true",
                    )

                    try {
                        await dataSource.manager.transaction(
                            async (manager) => {
                                const post = new Post()
                                post.name = "post"
                                await manager.save(post)
                            },
                        )
                        expect.fail("Should have thrown a 40001 error")
                    } catch (err) {
                        expect(err).to.be.instanceOf(QueryFailedError)
                        expect((err as any).code).to.equal("40001")
                    } finally {
                        await dataSource.query(
                            "SET inject_retry_errors_enabled = false",
                        )
                    }
                }),
            ))
    })
})
