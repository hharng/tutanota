import o from "@tutao/otest"
import { Notifications } from "../../../src/gui/Notifications.js"
import type { Spy } from "@tutao/tutanota-test-utils"
import { spy } from "@tutao/tutanota-test-utils"
import type { MailboxDetail } from "../../../src/mail/model/MailModel.js"
import { MailModel } from "../../../src/mail/model/MailModel.js"
import { MailFolderType, OperationType } from "../../../src/api/common/TutanotaConstants.js"
import { MailFolderTypeRef, MailTypeRef } from "../../../src/api/entities/tutanota/TypeRefs.js"
import type { EntityUpdateData } from "../../../src/api/main/EventController.js"
import { EntityClient } from "../../../src/api/common/EntityClient.js"
import { EntityRestClientMock } from "../api/worker/rest/EntityRestClientMock.js"
import nodemocker from "../nodemocker.js"
import { downcast } from "@tutao/tutanota-utils"
import { MailFacade } from "../../../src/api/worker/facades/lazy/MailFacade.js"
import { LoginController } from "../../../src/api/main/LoginController.js"
import { matchers, object, when } from "testdouble"
import { FolderSystem } from "../../../src/api/common/mail/FolderSystem.js"
import { WebsocketConnectivityModel } from "../../../src/misc/WebsocketConnectivityModel.js"
import { InboxRuleHandler } from "../../../src/mail/model/InboxRuleHandler.js"
import { UserController } from "../../../src/api/main/UserController.js"
import { createTestEntity } from "../TestUtils.js"

o.spec("MailModelTest", function () {
	let notifications: Partial<Notifications>
	let showSpy: Spy
	let model: MailModel
	const inboxFolder = createTestEntity(MailFolderTypeRef, { _id: ["folderListId", "inboxId"] })
	inboxFolder.mails = "instanceListId"
	inboxFolder.folderType = MailFolderType.INBOX
	const anotherFolder = createTestEntity(MailFolderTypeRef, { _id: ["folderListId", "archiveId"] })
	anotherFolder.mails = "anotherListId"
	anotherFolder.folderType = MailFolderType.ARCHIVE
	let mailboxDetails: Partial<MailboxDetail>[]
	let logins: LoginController
	let inboxRuleHandler: InboxRuleHandler

	o.beforeEach(function () {
		mailboxDetails = [
			{
				folders: new FolderSystem([inboxFolder]),
			},
		]
		notifications = {}
		showSpy = notifications.showNotification = spy()
		const restClient = new EntityRestClientMock()
		const connectivityModel = object<WebsocketConnectivityModel>()
		const mailFacade = nodemocker.mock<MailFacade>("mailFacade", {}).set()
		logins = object()
		let userController = object<UserController>()
		when(userController.isUpdateForLoggedInUserInstance(matchers.anything(), matchers.anything())).thenReturn(false)
		when(logins.getUserController()).thenReturn(userController)

		inboxRuleHandler = object()
		model = new MailModel(downcast(notifications), downcast({}), connectivityModel, mailFacade, new EntityClient(restClient), logins, inboxRuleHandler)
		// not pretty, but works
		model.mailboxDetails(mailboxDetails as MailboxDetail[])
	})
	o("doesn't send notification for another folder", async function () {
		await model.entityEventsReceived(
			[
				makeUpdate({
					instanceListId: anotherFolder.mails,
					operation: OperationType.CREATE,
				}),
			],
			"userGroupId",
		)
		o(showSpy.invocations.length).equals(0)
	})
	o("doesn't send notification for move operation", async function () {
		await model.entityEventsReceived(
			[
				makeUpdate({
					instanceListId: anotherFolder.mails,
					operation: OperationType.DELETE,
				}),
				makeUpdate({
					instanceListId: inboxFolder.mails,
					operation: OperationType.CREATE,
				}),
			],
			"userGroupId",
		)
		o(showSpy.invocations.length).equals(0)
	})

	function makeUpdate(arg: { instanceListId: string; operation: OperationType }): EntityUpdateData {
		return Object.assign(
			{},
			{
				type: MailTypeRef.type,
				application: MailTypeRef.app,
				instanceId: "instanceId",
			},
			arg,
		)
	}
})
