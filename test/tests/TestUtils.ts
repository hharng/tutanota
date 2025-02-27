import type { BrowserData } from "../../src/misc/ClientConstants.js"
import type { Db } from "../../src/api/worker/search/SearchTypes.js"
import { IndexerCore } from "../../src/api/worker/search/IndexerCore.js"
import { EventQueue } from "../../src/api/worker/EventQueue.js"
import { DbFacade, DbTransaction } from "../../src/api/worker/search/DbFacade.js"
import { Thunk, TypeRef } from "@tutao/tutanota-utils"
import type { DesktopKeyStoreFacade } from "../../src/desktop/DesktopKeyStoreFacade.js"
import { mock } from "@tutao/tutanota-test-utils"
import { aes256RandomKey, fixedIv, uint8ArrayToKey } from "@tutao/tutanota-crypto"
import { ScheduledPeriodicId, ScheduledTimeoutId, Scheduler } from "../../src/api/common/utils/Scheduler.js"
import { object, when } from "testdouble"
import { Entity, TypeModel } from "../../src/api/common/EntityTypes.js"
import { create } from "../../src/api/common/utils/EntityUtils.js"
import { typeModels } from "../../src/api/common/EntityFunctions.js"

export const browserDataStub: BrowserData = {
	needsMicrotaskHack: false,
	needsExplicitIDBIds: false,
	indexedDbSupported: true,
}

export function makeCore(
	args?: {
		db?: Db
		queue?: EventQueue
		browserData?: BrowserData
		transaction?: DbTransaction
	},
	mocker?: (_: any) => void,
): IndexerCore {
	const safeArgs = args ?? {}
	const { transaction } = safeArgs
	const defaultDb = {
		key: aes256RandomKey(),
		iv: fixedIv,
		dbFacade: { createTransaction: () => Promise.resolve(transaction) } as Partial<DbFacade>,
		initialized: Promise.resolve(),
	} as Partial<Db> as Db
	const defaultQueue = {} as Partial<EventQueue> as EventQueue
	const { db, queue, browserData } = {
		...{ db: defaultDb, browserData: browserDataStub, queue: defaultQueue },
		...safeArgs,
	}
	const core = new IndexerCore(db, queue, browserData)
	mocker && mock(core, mocker)
	return core
}

export function makeKeyStoreFacade(uint8ArrayKey: Uint8Array): DesktopKeyStoreFacade {
	const o: DesktopKeyStoreFacade = object()
	when(o.getDeviceKey()).thenResolve(uint8ArrayToKey(uint8ArrayKey))
	when(o.getCredentialsKey()).thenResolve(uint8ArrayToKey(uint8ArrayKey))
	return o
}

type IdThunk = {
	id: ScheduledTimeoutId
	thunk: Thunk
}

export class SchedulerMock implements Scheduler {
	alarmId: number = 0

	/** key is the time */
	scheduledAt: Map<number, IdThunk> = new Map()
	cancelledAt: Set<ScheduledTimeoutId> = new Set()
	scheduledPeriodic: Map<number, IdThunk> = new Map()
	cancelledPeriodic: Set<ScheduledTimeoutId> = new Set()

	scheduleAt(callback, date): ScheduledTimeoutId {
		const id = this._incAlarmId()

		this.scheduledAt.set(date.getTime(), {
			id,
			thunk: callback,
		})
		return id
	}

	unscheduleTimeout(id) {
		this.cancelledAt.add(id)
	}

	schedulePeriodic(thunk, period: number): ScheduledPeriodicId {
		const id = this._incAlarmId()
		this.scheduledPeriodic.set(period, { id, thunk })
		return id
	}

	unschedulePeriodic(id: ScheduledPeriodicId) {
		this.cancelledPeriodic.add(id)
	}

	_incAlarmId(): ScheduledTimeoutId {
		return this.alarmId++
	}
}

export const domainConfigStub: DomainConfig = {
	firstPartyDomain: true,
	partneredDomainTransitionUrl: "",
	apiUrl: "",
	u2fAppId: "",
	webauthnRpId: "",
	referralBaseUrl: "",
	giftCardBaseUrl: "",
	paymentUrl: "",
	webauthnUrl: "",
	legacyWebauthnUrl: "",
	webauthnMobileUrl: "",
	legacyWebauthnMobileUrl: "",
	websiteBaseUrl: "",
}

// non-async copy of the function
function resolveTypeReference(typeRef: TypeRef<any>): TypeModel {
	// @ts-ignore
	const modelMap = typeModels[typeRef.app]

	const typeModel = modelMap[typeRef.type]
	if (typeModel == null) {
		throw new Error("Cannot find TypeRef: " + JSON.stringify(typeRef))
	} else {
		return typeModel
	}
}

export function createTestEntity<T extends Entity>(typeRef: TypeRef<T>, values?: Partial<T>): T {
	const typeModel = resolveTypeReference(typeRef as TypeRef<any>)
	const entity = create(typeModel, typeRef)
	if (values) {
		return Object.assign(entity, values)
	} else {
		return entity
	}
}
