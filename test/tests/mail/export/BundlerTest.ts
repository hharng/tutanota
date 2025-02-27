import o from "@tutao/otest"
import { makeMailBundle } from "../../../../src/mail/export/Bundler.js"
import {
	createEncryptedMailAddress,
	createMail,
	createMailAddress,
	FileTypeRef,
	MailAddressTypeRef,
	MailBodyTypeRef,
	MailHeadersTypeRef,
	MailTypeRef,
} from "../../../../src/api/entities/tutanota/TypeRefs.js"
import { MailState } from "../../../../src/api/common/TutanotaConstants.js"
import { DataFile } from "../../../../src/api/common/DataFile.js"
import { HtmlSanitizer } from "../../../../src/misc/HtmlSanitizer.js"
import { EntityClient } from "../../../../src/api/common/EntityClient.js"
import { FileController } from "../../../../src/file/FileController.js"
import { object, when } from "testdouble"
import { MailFacade } from "../../../../src/api/worker/facades/lazy/MailFacade.js"
import { createTestEntity } from "../../TestUtils.js"

o.spec("Bundler", function () {
	let entityClientMock: EntityClient
	let fileControllerMock: FileController
	let sanitizerMock: HtmlSanitizer
	let mailFacadeMock: MailFacade

	o.beforeEach(function () {
		entityClientMock = object()
		fileControllerMock = object()
		sanitizerMock = object()
		mailFacadeMock = object()
	})
	o("make mail bundle non compressed headers", async function () {
		const mailId: IdTuple = ["maillistid", "maillid"]
		const subject = "hello"
		const mailBodyId = "mailbodyid"
		const body = "This is the body text of the body of the email"
		const sanitizedBodyText = "this is the sanitized body text of the email"
		const sender = { address: "sender@mycoolsite.co.uk", name: "the sender" }
		const to = [{ address: "to@mycoolsite.co.uk", name: "the to" }]
		const cc = [{ address: "cc@mycoolsite.co.uk", name: "the cc" }]
		const bcc = [{ address: "bcc@mycoolsite.co.uk", name: "the bcc" }]
		const replyTo = [{ address: "replyto@mycoolsite.co.uk", name: "the replyto" }]
		const sentOn = new Date()
		const receivedOn = new Date()
		const headers = "this is the headers"
		const mailHeadersId = "mailheadersid"
		const attachmentListId: Id = "attachmentListId"
		const attachmentIds: Id[] = ["attachmentId1", "attachmentId2", "attachmentId3"]
		const attachments: Array<DataFile> = attachmentIds.map((id) => {
			return {
				_type: "DataFile",
				id: undefined,
				name: id,
				cid: id,
				data: new Uint8Array(),
				size: 4,
				mimeType: "test",
			}
		})
		const mail = createTestEntity(MailTypeRef, {
			_id: mailId,
			body: mailBodyId,
			subject,
			sender: createTestEntity(MailAddressTypeRef, sender),
			toRecipients: to.map(createMailAddress),
			ccRecipients: cc.map(createMailAddress),
			bccRecipients: bcc.map(createMailAddress),
			replyTos: replyTo.map(createEncryptedMailAddress),
			state: MailState.RECEIVED,
			unread: false,
			receivedDate: receivedOn,
			sentDate: sentOn,
			headers: mailHeadersId,
			attachments: attachmentIds.map((id) => [attachmentListId, id] as IdTuple),
		})

		when(entityClientMock.load(MailHeadersTypeRef, mailHeadersId)).thenResolve({ headers })

		for (const attachment of attachments) {
			// the file is only needed to pass to the fileController and is not kept, so we mock it as a string for convenience
			when(entityClientMock.load(FileTypeRef, [attachmentListId, attachment.name])).thenResolve(`file ${attachment.name}` as any)
			when(fileControllerMock.getAsDataFile(`file ${attachment.name}` as any)).thenResolve(attachment)
		}

		when(entityClientMock.load(MailBodyTypeRef, mailBodyId)).thenResolve({ text: body })
		when(
			sanitizerMock.sanitizeHTML(body, {
				blockExternalContent: false,
				allowRelativeLinks: false,
				usePlaceholderForInlineImages: false,
			}),
		).thenReturn({ html: sanitizedBodyText })

		const bundle = await makeMailBundle(mail, mailFacadeMock, entityClientMock, fileControllerMock, sanitizerMock)

		o(bundle).deepEquals({
			mailId: mailId,
			subject: subject,
			sender: sender,
			body: sanitizedBodyText,
			to: to,
			cc: cc,
			bcc: bcc,
			replyTo: replyTo,
			isDraft: false,
			isRead: true,
			headers: headers,
			attachments: attachments,
			sentOn: sentOn.getTime(),
			receivedOn: receivedOn.getTime(),
		})
	})
})
