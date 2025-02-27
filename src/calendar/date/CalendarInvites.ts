import { parseCalendarFile } from "../export/CalendarImporter"
import type { CalendarEvent, CalendarEventAttendee, File as TutanotaFile, Mail } from "../../api/entities/tutanota/TypeRefs.js"
import { locator } from "../../api/main/MainLocator"
import { CalendarAttendeeStatus, CalendarMethod, ConversationType, FeatureType, getAsEnumValue } from "../../api/common/TutanotaConstants"
import { assert, assertNotNull, clone, filterInt, noOp, Require } from "@tutao/tutanota-utils"
import { findPrivateCalendar, getEventType } from "./CalendarUtils"
import { calendarNotificationSender } from "./CalendarNotificationSender.js"
import { Dialog } from "../../gui/base/Dialog"
import { UserError } from "../../api/main/UserError"
import { NoopProgressMonitor } from "../../api/common/utils/ProgressMonitor"
import { DataFile } from "../../api/common/DataFile"
import { findAttendeeInAddresses } from "../../api/common/utils/CommonCalendarUtils.js"
import { Recipient } from "../../api/common/recipients/Recipient.js"
import { isCustomizationEnabledForCustomer } from "../../api/common/utils/Utils.js"
import { SendMailModel } from "../../mail/editor/SendMailModel.js"
import { CalendarEventModel, CalendarOperation, EventType } from "./eventeditor/CalendarEventModel.js"
import { CalendarNotificationModel } from "./eventeditor/CalendarNotificationModel.js"
import { RecipientField } from "../../mail/model/MailUtils.js"
import { ResolveMode } from "../../api/main/RecipientsModel.js"

// not picking the status directly from CalendarEventAttendee because it's a NumberString
export type Guest = Recipient & { status: CalendarAttendeeStatus }

export type ParsedIcalFileContent =
	| {
			method: CalendarMethod
			events: Array<CalendarEvent>
			uid: string
	  }
	| None

async function getParsedEvent(fileData: DataFile): Promise<ParsedIcalFileContent> {
	try {
		const { contents, method } = await parseCalendarFile(fileData)
		const uid = contents[0].event.uid
		if (uid == null) return null
		assert(!contents.some((c) => c.event.uid !== uid), "received invite with multiple events, but mismatched UIDs")
		return {
			events: contents.map((c) => c.event),
			uid,
			method: getAsEnumValue(CalendarMethod, method) || CalendarMethod.PUBLISH,
		}
	} catch (e) {
		console.log(e)
		return null
	}
}

export async function showEventDetails(event: CalendarEvent, eventBubbleRect: ClientRect, mail: Mail | null): Promise<void> {
	const [latestEvent, { CalendarEventPopup }, { CalendarEventPreviewViewModel }, { htmlSanitizer }] = await Promise.all([
		getLatestEvent(event),
		import("../view/eventpopup/CalendarEventPopup.js"),
		import("../view/eventpopup/CalendarEventPreviewViewModel.js"),
		import("../../misc/HtmlSanitizer"),
	])

	let eventType: EventType
	let editModelsFactory: (mode: CalendarOperation) => Promise<CalendarEventModel | null>
	let hasBusinessFeature: boolean
	let ownAttendee: CalendarEventAttendee | null = null
	const lazyIndexEntry = async () => (latestEvent.uid != null ? locator.calendarFacade.getEventsByUid(latestEvent.uid) : null)
	if (!locator.logins.getUserController().isInternalUser()) {
		// external users cannot delete/edit events as they have no calendar.
		eventType = EventType.EXTERNAL
		editModelsFactory = () => new Promise(noOp)
		hasBusinessFeature = false
	} else {
		const [calendarInfos, mailboxDetails, customer] = await Promise.all([
			(await locator.calendarModel()).loadOrCreateCalendarInfo(new NoopProgressMonitor()),
			locator.mailModel.getUserMailboxDetails(),
			locator.logins.getUserController().loadCustomer(),
		])
		const mailboxProperties = await locator.mailModel.getMailboxProperties(mailboxDetails.mailboxGroupRoot)
		const ownMailAddresses = mailboxProperties.mailAddressProperties.map(({ mailAddress }) => mailAddress)
		ownAttendee = findAttendeeInAddresses(latestEvent.attendees, ownMailAddresses)
		eventType = getEventType(latestEvent, calendarInfos, ownMailAddresses, locator.logins.getUserController().user)
		editModelsFactory = (mode: CalendarOperation) => locator.calendarEventModel(mode, latestEvent, mailboxDetails, mailboxProperties, mail)
		hasBusinessFeature =
			isCustomizationEnabledForCustomer(customer, FeatureType.BusinessFeatureEnabled) || (await locator.logins.getUserController().isNewPaidPlan())
	}

	const viewModel = new CalendarEventPreviewViewModel(
		latestEvent,
		await locator.calendarModel(),
		eventType,
		hasBusinessFeature,
		ownAttendee,
		lazyIndexEntry,
		editModelsFactory,
	)
	new CalendarEventPopup(viewModel, eventBubbleRect, htmlSanitizer).show()
}

export async function getEventsFromFile(file: TutanotaFile, invitedConfidentially: boolean): Promise<ParsedIcalFileContent> {
	const dataFile = await locator.fileController.getAsDataFile(file)
	const contents = await getParsedEvent(dataFile)
	for (const event of contents?.events ?? []) {
		event.invitedConfidentially = invitedConfidentially
	}
	return contents
}

/**
 * Returns the latest version for the given event by uid and recurrenceId. If the event is not in
 * any calendar (because it has not been stored yet, e.g. in case of invite)
 * the given event is returned.
 */
export async function getLatestEvent(event: CalendarEvent): Promise<CalendarEvent> {
	const uid = event.uid
	if (uid == null) return event
	const existingEvents = await locator.calendarFacade.getEventsByUid(uid)

	// If the file we are opening is newer than the one which we have on the server, update server version.
	// Should not happen normally but can happen when e.g. reply and update were sent one after another before we accepted
	// the invite. Then accepting first invite and then opening update should give us updated version.
	const existingEvent =
		event.recurrenceId == null
			? existingEvents?.progenitor // the progenitor does not have a recurrence id and is always first in uid index
			: existingEvents?.alteredInstances.find((e) => e.recurrenceId === event.recurrenceId)

	if (existingEvent == null) return event

	if (filterInt(existingEvent.sequence) < filterInt(event.sequence)) {
		const calendarModel = await locator.calendarModel()
		return await calendarModel.updateEventWithExternal(existingEvent, event)
	} else {
		return existingEvent
	}
}

export const enum ReplyResult {
	ReplyNotSent,
	ReplySent,
}

/**
 * Sends a quick reply for the given event and saves the event to the first private calendar.
 * @param event the CalendarEvent to respond to, will be serialized and sent back with updated status, then saved.
 * @param attendee the attendee that should respond to the mail
 * @param decision the new status of the attendee
 * @param previousMail the mail to respond to
 */
export async function replyToEventInvitation(
	event: CalendarEvent,
	attendee: CalendarEventAttendee,
	decision: CalendarAttendeeStatus,
	previousMail: Mail,
): Promise<ReplyResult> {
	const eventClone = clone(event)
	const foundAttendee = assertNotNull(findAttendeeInAddresses(eventClone.attendees, [attendee.address.address]), "attendee was not found in event clone")
	foundAttendee.status = decision

	const notificationModel = new CalendarNotificationModel(calendarNotificationSender, locator.logins)
	const responseModel = await getResponseModelForMail(previousMail, attendee.address.address)

	try {
		await notificationModel.send(eventClone, [], { responseModel, inviteModel: null, cancelModel: null, updateModel: null })
	} catch (e) {
		if (e instanceof UserError) {
			await Dialog.message(() => e.message)
			return ReplyResult.ReplyNotSent
		} else {
			throw e
		}
	}
	const calendarModel = await locator.calendarModel()
	const calendar = await calendarModel.loadOrCreateCalendarInfo(new NoopProgressMonitor()).then(findPrivateCalendar)
	if (calendar == null) return ReplyResult.ReplyNotSent
	if (decision !== CalendarAttendeeStatus.DECLINED && eventClone.uid != null) {
		const dbEvents = await calendarModel.getEventsByUid(eventClone.uid)
		await calendarModel.processCalendarEventMessage(
			previousMail.sender.address,
			CalendarMethod.REQUEST,
			eventClone as Require<"uid", CalendarEvent>,
			[],
			dbEvents ?? { ownerGroup: calendar.group._id, progenitor: null, alteredInstances: [] },
		)
	}
	return ReplyResult.ReplySent
}

export async function getResponseModelForMail(previousMail: Mail, responder: string): Promise<SendMailModel | null> {
	const mailboxDetails = await locator.mailModel.getMailboxDetailsForMail(previousMail)
	if (mailboxDetails == null) return null
	const mailboxProperties = await locator.mailModel.getMailboxProperties(mailboxDetails.mailboxGroupRoot)
	const model = await locator.sendMailModel(mailboxDetails, mailboxProperties)
	await model.initAsResponse(
		{
			previousMail,
			conversationType: ConversationType.REPLY,
			senderMailAddress: responder,
			recipients: [],
			attachments: [],
			subject: "",
			bodyText: "",
			replyTos: [],
		},
		new Map(),
	)
	await model.addRecipient(RecipientField.TO, previousMail.sender, ResolveMode.Eager)
	// Send confidential reply to confidential mails and the other way around.
	// If the contact is removed or the password is not there the user would see an error but they wouldn't be
	// able to reply anyway (unless they fix it).
	model.setConfidential(previousMail.confidential)
	return model
}
