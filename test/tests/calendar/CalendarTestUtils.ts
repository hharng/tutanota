import { AccountType, ContactAddressType, FeatureType, GroupType, ShareCapability, TimeFormat } from "../../../src/api/common/TutanotaConstants.js"
import type { UserController } from "../../../src/api/main/UserController.js"
import {
	BookingsRefTypeRef,
	createBookingsRef,
	createCustomer,
	createCustomerInfo,
	createFeature,
	createGroup,
	createGroupInfo,
	createGroupMembership,
	createMailAddressAlias,
	createPlanConfiguration,
	createUser,
	CustomerInfoTypeRef,
	CustomerTypeRef,
	Feature,
	FeatureTypeRef,
	GroupInfoTypeRef,
	GroupMembershipTypeRef,
	GroupTypeRef,
	MailAddressAliasTypeRef,
	PlanConfigurationTypeRef,
	User,
	UserTypeRef,
} from "../../../src/api/entities/sys/TypeRefs.js"
import { GENERATED_MAX_ID } from "../../../src/api/common/utils/EntityUtils.js"
import { downcast, LazyLoaded } from "@tutao/tutanota-utils"
import type { CalendarEvent } from "../../../src/api/entities/tutanota/TypeRefs.js"
import {
	CalendarEventTypeRef,
	CalendarGroupRootTypeRef,
	ContactAddressTypeRef,
	ContactTypeRef,
	createCalendarEvent,
	createCalendarGroupRoot,
	createContact,
	createContactAddress,
	createEncryptedMailAddress,
	createMailBox,
	createMailboxGroupRoot,
	createTutanotaProperties,
	EncryptedMailAddress,
	EncryptedMailAddressTypeRef,
	MailboxGroupRootTypeRef,
	MailBoxTypeRef,
	TutanotaPropertiesTypeRef,
} from "../../../src/api/entities/tutanota/TypeRefs.js"
import type { MailboxDetail } from "../../../src/mail/model/MailModel.js"
import o from "@tutao/otest"
import type { CalendarInfo } from "../../../src/calendar/model/CalendarModel"
import { CalendarModel } from "../../../src/calendar/model/CalendarModel"
import { FolderSystem } from "../../../src/api/common/mail/FolderSystem.js"
import { Recipient, RecipientType } from "../../../src/api/common/recipients/Recipient.js"
import { DateTime } from "luxon"
import { spy } from "@tutao/tutanota-test-utils"
import { createTestEntity } from "../TestUtils.js"

export const ownerMailAddress = "calendarowner@tutanota.de" as const
export const ownerId = "ownerId" as const
export const calendarGroupId = "0" as const

export const ownerAddress = createTestEntity(EncryptedMailAddressTypeRef, {
	address: ownerMailAddress,
	name: "Calendar Owner",
})
export const ownerRecipient: Recipient = {
	address: ownerAddress.address,
	name: ownerAddress.name,
	type: RecipientType.INTERNAL,
	contact: null,
}
export const ownerAlias = createTestEntity(EncryptedMailAddressTypeRef, {
	address: "calendarowneralias@tutanota.de",
	name: "Calendar Owner Alias",
})
export const ownerAliasRecipient: Recipient = {
	address: ownerAlias.address,
	name: ownerAlias.name,
	type: RecipientType.INTERNAL,
	contact: null,
}
export const otherAddress = createTestEntity(EncryptedMailAddressTypeRef, {
	address: "someone@tutanota.de",
	name: "Some One",
})
export const otherRecipient: Recipient = {
	address: otherAddress.address,
	name: otherAddress.name,
	type: RecipientType.EXTERNAL,
	contact: createTestEntity(ContactTypeRef, {
		nickname: otherAddress.name,
		presharedPassword: "otherPassword",
		addresses: [
			createTestEntity(ContactAddressTypeRef, {
				address: otherAddress.address,
				type: ContactAddressType.WORK,
			}),
		],
	}),
}
export const otherAddress2 = createTestEntity(EncryptedMailAddressTypeRef, {
	address: "someoneelse@tutanota.de",
	name: "Some One Else",
})
export const otherRecipient2: Recipient = {
	address: otherAddress2.address,
	name: otherAddress2.name,
	type: RecipientType.INTERNAL,
	contact: createTestEntity(ContactTypeRef, {
		nickname: otherAddress2.name,
		presharedPassword: "otherPassword2",
		addresses: [
			createTestEntity(ContactAddressTypeRef, {
				address: otherAddress2.address,
				type: ContactAddressType.WORK,
			}),
		],
	}),
}

export const thirdAddress = createTestEntity(EncryptedMailAddressTypeRef, { address: "somethirdaddress@tuta.com", name: "thirdperson" })
export const thirdRecipient: Recipient = {
	address: thirdAddress.address,
	name: thirdAddress.name,
	type: RecipientType.INTERNAL,
	contact: createTestEntity(ContactTypeRef, {
		nickname: "drei",
		presharedPassword: "noPassword",
		addresses: [
			createTestEntity(ContactAddressTypeRef, {
				address: thirdAddress.address,
				type: ContactAddressType.OTHER,
			}),
		],
	}),
}

export const calendars: ReadonlyMap<Id, CalendarInfo> = new Map([
	[
		"ownCalendar",
		{
			groupRoot: createTestEntity(CalendarGroupRootTypeRef, {}),
			shared: false,
			longEvents: new LazyLoaded(() => Promise.resolve([])),
			groupInfo: createTestEntity(GroupInfoTypeRef, {}),
			group: createTestEntity(GroupTypeRef, {
				_id: "ownCalendar",
				user: "ownerId",
				type: GroupType.Calendar,
			}),
		},
	],
	[
		"sharedCalendar",
		{
			groupRoot: createTestEntity(CalendarGroupRootTypeRef, {}),
			shared: true,
			longEvents: new LazyLoaded(() => Promise.resolve([])),
			groupInfo: createTestEntity(GroupInfoTypeRef, {}),
			group: createTestEntity(GroupTypeRef, {
				_id: "sharedCalendar",
				user: "otherId",
				type: GroupType.Calendar,
			}),
		},
	],
])

export const ownAddresses: ReadonlyArray<EncryptedMailAddress> = [ownerAddress, ownerAlias]

export function makeUserController(
	aliases: Array<string> = [],
	accountType: AccountType = AccountType.PAID,
	defaultSender?: string,
	businessFeatureOrdered: boolean = false,
	isNewPaidPlan: boolean = false,
): UserController {
	const bookingsRef = createTestEntity(BookingsRefTypeRef, {
		items: GENERATED_MAX_ID,
	})
	const customizations: Feature[] = []

	if (businessFeatureOrdered) {
		customizations.push(
			createTestEntity(FeatureTypeRef, {
				feature: FeatureType.BusinessFeatureEnabled,
			}),
		)
	}

	return downcast({
		user: createTestEntity(UserTypeRef, {
			_id: ownerId,
			memberships: [
				createTestEntity(GroupMembershipTypeRef, {
					groupType: GroupType.Mail,
				}),
				createTestEntity(GroupMembershipTypeRef, {
					groupType: GroupType.Contact,
				}),
			],
			accountType,
		}),
		props: createTestEntity(TutanotaPropertiesTypeRef, {
			defaultSender: defaultSender || ownerMailAddress,
		}),
		userGroupInfo: createTestEntity(GroupInfoTypeRef, {
			mailAddressAliases: aliases.map((address) =>
				createTestEntity(MailAddressAliasTypeRef, {
					mailAddress: address,
					enabled: true,
				}),
			),
			mailAddress: ownerMailAddress,
		}),
		userSettingsGroupRoot: {
			timeFormat: TimeFormat.TWENTY_FOUR_HOURS,
		},
		isInternalUser: () => true,
		isFreeAccount: () => true,
		isNewPaidPlan: () => isNewPaidPlan,
		loadCustomer: () =>
			Promise.resolve(
				createTestEntity(CustomerTypeRef, {
					customizations: customizations,
				}),
			),
		loadCustomerInfo: () =>
			Promise.resolve(
				createTestEntity(CustomerInfoTypeRef, {
					bookings: bookingsRef,
				}),
			),
		getCalendarMemberships: () => {
			//TODO
			return []
		},
		getPlanConfig: () =>
			Promise.resolve(
				createTestEntity(PlanConfigurationTypeRef, {
					eventInvites: businessFeatureOrdered || isNewPaidPlan,
				}),
			),
	})
}

export function makeMailboxDetail(): MailboxDetail {
	return {
		mailbox: createTestEntity(MailBoxTypeRef),
		folders: new FolderSystem([]),
		mailGroupInfo: createTestEntity(GroupInfoTypeRef),
		mailGroup: createTestEntity(GroupTypeRef, {
			user: ownerId,
		}),
		mailboxGroupRoot: createTestEntity(MailboxGroupRootTypeRef),
	}
}

export function makeCalendarInfo(type: "own" | "shared", id: string): CalendarInfo {
	return {
		groupRoot: downcast({
			longEvents: "longEventsList",
			shortEvents: "shortEventsList",
		}),
		longEvents: new LazyLoaded(() => Promise.resolve([])),
		groupInfo: downcast({}),
		group: createTestEntity(GroupTypeRef, {
			_id: id,
			type: GroupType.Calendar,
			user: type === "own" ? ownerId : "anotherUserId",
		}),
		shared: type === "shared",
	}
}

export function makeCalendars(type: "own" | "shared", id: string = calendarGroupId): Map<string, CalendarInfo> {
	const calendarInfo = makeCalendarInfo(type, id)
	return new Map([[id, calendarInfo]])
}

export function makeCalendarModel(): CalendarModel {
	return downcast({
		createEvent: spy(() => Promise.resolve()),
		updateEvent: spy(() => Promise.resolve()),
		deleteEvent: spy(() => Promise.resolve()),
		loadAlarms: spy(() => Promise.resolve([])),
		loadCalendarInfos: () => {
			return Promise.resolve(makeCalendars("own", calendarGroupId))
		},
		loadOrCreateCalendarInfo: () => {
			return Promise.resolve(makeCalendars("own", calendarGroupId))
		},
		createCalendar: () => Promise.resolve(),
	})
}

function id(element: string): IdTuple {
	return ["list", element]
}

export function makeEvent(_id: string, startTime: Date, endTime: Date, uid: string = ""): CalendarEvent {
	return createTestEntity(CalendarEventTypeRef, {
		_ownerGroup: "ownerGroup",
		_id: id(_id),
		startTime,
		endTime,
		uid,
	})
}

export function addCapability(user: User, groupId: Id, capability: ShareCapability) {
	user.memberships.push(
		createTestEntity(GroupMembershipTypeRef, {
			group: groupId,
			capability,
		}),
	)
}

export const zone = "Europe/Berlin"

/** create a js date object corresponding to the given ISO-like date string (YYYY-MM-DDTHH:MM)in
 * the {@param useZone} time zone, which defaults to Europe/Berlin (UTC+2)
 * times can be omitted.
 * */
export function getDateInZone(iso: string, useZone = zone): Date {
	const dt = DateTime.fromISO(iso, { zone: useZone })
	if (!dt.isValid) {
		throw new Error(`Invalid date! ${iso} ${dt.invalidExplanation}`)
	}
	return dt.toJSDate()
}

/** create a js date object corresponding to the given ISO-like date string (YYYY-MM-DDTHH:MM)in
 * the utc time zone
 * times can be omitted.
 * */
export function getDateInUTC(iso: string): Date {
	const dt = DateTime.fromISO(iso, { zone: "utc" })
	if (!dt.isValid) {
		throw new Error(`Invalid date! ${iso} ${dt.invalidExplanation}`)
	}
	return dt.toJSDate()
}
