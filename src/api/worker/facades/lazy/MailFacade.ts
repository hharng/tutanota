import type { CryptoFacade } from "../../crypto/CryptoFacade.js"
import { encryptBytes, encryptString } from "../../crypto/CryptoFacade.js"
import {
	DraftService,
	ExternalUserService,
	ListUnsubscribeService,
	MailFolderService,
	MailService,
	MoveMailService,
	ReportMailService,
	SendDraftService,
} from "../../../entities/tutanota/Services.js"
import type { ConversationType } from "../../../common/TutanotaConstants.js"
import {
	ArchiveDataType,
	CounterType,
	DEFAULT_KDF_TYPE,
	GroupType,
	MailAuthenticationStatus,
	MailMethod,
	MailReportType,
	OperationType,
	PhishingMarkerStatus,
	ReportedMailFieldType,
	SYSTEM_GROUP_MAIL_ADDRESS,
} from "../../../common/TutanotaConstants.js"
import type {
	Contact,
	DraftAttachment,
	DraftRecipient,
	EncryptedMailAddress,
	File as TutanotaFile,
	InternalRecipientKeyData,
	Mail,
	MailFolder,
	ReportedMailFieldMarker,
	SendDraftData,
	SymEncInternalRecipientKeyData,
} from "../../../entities/tutanota/TypeRefs.js"
import {
	createAttachmentKeyData,
	createCreateExternalUserGroupData,
	createCreateMailFolderData,
	createDeleteMailData,
	createDeleteMailFolderData,
	createDraftAttachment,
	createDraftCreateData,
	createDraftData,
	createDraftRecipient,
	createDraftUpdateData,
	createEncryptedMailAddress,
	createExternalUserData,
	createListUnsubscribeData,
	createMoveMailData,
	createNewDraftAttachment,
	createReportMailPostData,
	createSecureExternalRecipientKeyData,
	createSendDraftData,
	createUpdateMailFolderData,
	FileTypeRef,
	InternalRecipientKeyDataTypeRef,
	MailDetails,
	MailDetailsBlobTypeRef,
	MailDetailsDraftTypeRef,
	MailTypeRef,
	SymEncInternalRecipientKeyDataTypeRef,
	TutanotaPropertiesTypeRef,
} from "../../../entities/tutanota/TypeRefs.js"
import { RecipientsNotFoundError } from "../../../common/error/RecipientsNotFoundError.js"
import { NotFoundError } from "../../../common/error/RestError.js"
import type { EntityUpdate, PublicKeyGetOut, User } from "../../../entities/sys/TypeRefs.js"
import {
	BlobReferenceTokenWrapper,
	createPublicKeyGetIn,
	ExternalUserReferenceTypeRef,
	GroupInfoTypeRef,
	GroupRootTypeRef,
	GroupTypeRef,
	UserTypeRef,
} from "../../../entities/sys/TypeRefs.js"
import {
	addressDomain,
	assertNotNull,
	byteLength,
	contains,
	defer,
	isNotNull,
	isSameTypeRef,
	isSameTypeRefByAttr,
	lazyMemoized,
	noOp,
	ofClass,
	promiseFilter,
	promiseMap,
} from "@tutao/tutanota-utils"
import { BlobFacade } from "./BlobFacade.js"
import { assertWorkerOrNode, isApp, isDesktop } from "../../../common/Env.js"
import { EntityClient } from "../../../common/EntityClient.js"
import { getEnabledMailAddressesForGroupInfo, getUserGroupMemberships } from "../../../common/utils/GroupUtils.js"
import { containsId, elementIdPart, getLetId, isSameId, listIdPart, stringToCustomId } from "../../../common/utils/EntityUtils.js"
import { htmlToText } from "../../search/IndexUtils.js"
import { MailBodyTooLargeError } from "../../../common/error/MailBodyTooLargeError.js"
import { UNCOMPRESSED_MAX_SIZE } from "../../Compression.js"
import {
	aes256RandomKey,
	bitArrayToUint8Array,
	createAuthVerifier,
	decryptKey,
	encryptKey,
	generateRandomSalt,
	keyToUint8Array,
	murmurHash,
	random,
	sha256Hash,
} from "@tutao/tutanota-crypto"
import { DataFile } from "../../../common/DataFile.js"
import { FileReference, isDataFile, isFileReference } from "../../../common/utils/FileUtils.js"
import { CounterService } from "../../../entities/monitor/Services.js"
import { PublicKeyService } from "../../../entities/sys/Services.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { createWriteCounterData } from "../../../entities/monitor/TypeRefs.js"
import { UserFacade } from "../UserFacade.js"
import { PartialRecipient, Recipient, RecipientList, RecipientType } from "../../../common/recipients/Recipient.js"
import { NativeFileApp } from "../../../../native/common/FileApp.js"
import { isDetailsDraft, isLegacyMail } from "../../../common/MailWrapper.js"
import { LoginFacade } from "../LoginFacade.js"
import { ProgrammingError } from "../../../common/error/ProgrammingError.js"
import { OwnerEncSessionKeyProvider } from "../../rest/EntityRestClient.js"
import { resolveTypeReference } from "../../../common/EntityFunctions.js"

assertWorkerOrNode()
type Attachments = ReadonlyArray<TutanotaFile | DataFile | FileReference>

interface CreateDraftParams {
	subject: string
	bodyText: string
	senderMailAddress: string
	senderName: string
	toRecipients: RecipientList
	ccRecipients: RecipientList
	bccRecipients: RecipientList
	conversationType: ConversationType
	previousMessageId: Id | null
	attachments: Attachments | null
	confidential: boolean
	replyTos: RecipientList
	method: MailMethod
}

interface UpdateDraftParams {
	subject: string
	body: string
	senderMailAddress: string
	senderName: string
	toRecipients: RecipientList
	ccRecipients: RecipientList
	bccRecipients: RecipientList
	attachments: Attachments | null
	confidential: boolean
	draft: Mail
}

export class MailFacade {
	private phishingMarkers: Set<string> = new Set()
	private deferredDraftId: IdTuple | null = null // the mail id of the draft that we are waiting for to be updated via websocket
	private deferredDraftUpdate: Record<string, any> | null = null // this deferred promise is resolved as soon as the update of the draft is received

	constructor(
		private readonly userFacade: UserFacade,
		private readonly entityClient: EntityClient,
		private readonly crypto: CryptoFacade,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly blobFacade: BlobFacade,
		private readonly fileApp: NativeFileApp,
		private readonly loginFacade: LoginFacade,
	) {}

	async createMailFolder(name: string, parent: IdTuple | null, ownerGroupId: Id): Promise<void> {
		const mailGroupKey = this.userFacade.getGroupKey(ownerGroupId)

		const sk = aes256RandomKey()
		const newFolder = createCreateMailFolderData({
			folderName: name,
			parentFolder: parent,
			ownerEncSessionKey: encryptKey(mailGroupKey, sk),
			ownerGroup: ownerGroupId,
		})
		await this.serviceExecutor.post(MailFolderService, newFolder, { sessionKey: sk })
	}

	/**
	 * Updates a mail folder's name, if needed
	 * @param newName - if this is the same as the folder's current name, nothing is done
	 */
	async updateMailFolderName(folder: MailFolder, newName: string): Promise<void> {
		if (newName !== folder.name) {
			folder.name = newName
			await this.entityClient.update(folder)
		}
	}

	/**
	 * Updates a mail folder's parent, if needed
	 * @param newParent - if this is the same as the folder's current parent, nothing is done
	 */
	async updateMailFolderParent(folder: MailFolder, newParent: IdTuple | null): Promise<void> {
		if (
			(folder.parentFolder != null && newParent != null && !isSameId(folder.parentFolder, newParent)) ||
			(folder.parentFolder == null && newParent != null) ||
			(folder.parentFolder != null && newParent == null)
		) {
			const updateFolder = createUpdateMailFolderData({
				folder: folder._id,
				newParent: newParent,
			})
			await this.serviceExecutor.put(MailFolderService, updateFolder)
		}
	}

	/**
	 * Creates a draft mail.
	 * @param bodyText The bodyText of the mail formatted as HTML.
	 * @param previousMessageId The id of the message that this mail is a reply or forward to. Null if this is a new mail.
	 * @param attachments The files that shall be attached to this mail or null if no files shall be attached. TutanotaFiles are already exising on the server, DataFiles are files from the local file system. Attention: the DataFile class information is lost
	 * @param confidential True if the mail shall be sent end-to-end encrypted, false otherwise.
	 */
	async createDraft({
		subject,
		bodyText,
		senderMailAddress,
		senderName,
		toRecipients,
		ccRecipients,
		bccRecipients,
		conversationType,
		previousMessageId,
		attachments,
		confidential,
		replyTos,
		method,
	}: CreateDraftParams): Promise<Mail> {
		if (byteLength(bodyText) > UNCOMPRESSED_MAX_SIZE) {
			throw new MailBodyTooLargeError(`Can't update draft, mail body too large (${byteLength(bodyText)})`)
		}

		const senderMailGroupId = await this._getMailGroupIdForMailAddress(this.userFacade.getLoggedInUser(), senderMailAddress)

		const userGroupKey = this.userFacade.getUserGroupKey()

		const mailGroupKey = this.userFacade.getGroupKey(senderMailGroupId)

		const sk = aes256RandomKey()
		const service = createDraftCreateData({
			previousMessageId: previousMessageId,
			conversationType: conversationType,
			ownerEncSessionKey: encryptKey(mailGroupKey, sk),
			symEncSessionKey: encryptKey(userGroupKey, sk), // legacy
			draftData: createDraftData({
				subject,
				compressedBodyText: bodyText,
				senderMailAddress,
				senderName,
				confidential,
				method,
				toRecipients: toRecipients.map(recipientToDraftRecipient),
				ccRecipients: ccRecipients.map(recipientToDraftRecipient),
				bccRecipients: bccRecipients.map(recipientToDraftRecipient),
				replyTos: replyTos.map(recipientToEncryptedMailAddress),
				addedAttachments: await this._createAddedAttachments(attachments, [], senderMailGroupId, mailGroupKey),
				bodyText: "",
				removedAttachments: [],
			}),
		})
		const createDraftReturn = await this.serviceExecutor.post(DraftService, service, { sessionKey: sk })
		return this.entityClient.load(MailTypeRef, createDraftReturn.draft)
	}

	/**
	 * Updates a draft mail.
	 * @param subject The subject of the mail.
	 * @param body The body text of the mail.
	 * @param senderMailAddress The senders mail address.
	 * @param senderName The name of the sender that is sent together with the mail address of the sender.
	 * @param toRecipients The recipients the mail shall be sent to.
	 * @param ccRecipients The recipients the mail shall be sent to in cc.
	 * @param bccRecipients The recipients the mail shall be sent to in bcc.
	 * @param attachments The files that shall be attached to this mail or null if the current attachments shall not be changed.
	 * @param confidential True if the mail shall be sent end-to-end encrypted, false otherwise.
	 * @param draft The draft to update.
	 * @return The updated draft. Rejected with TooManyRequestsError if the number allowed mails was exceeded, AccessBlockedError if the customer is not allowed to send emails currently because he is marked for approval.
	 */
	async updateDraft({
		subject,
		body,
		senderMailAddress,
		senderName,
		toRecipients,
		ccRecipients,
		bccRecipients,
		attachments,
		confidential,
		draft,
	}: UpdateDraftParams): Promise<Mail> {
		if (byteLength(body) > UNCOMPRESSED_MAX_SIZE) {
			throw new MailBodyTooLargeError(`Can't update draft, mail body too large (${byteLength(body)})`)
		}

		const senderMailGroupId = await this._getMailGroupIdForMailAddress(this.userFacade.getLoggedInUser(), senderMailAddress)

		const mailGroupKey = this.userFacade.getGroupKey(senderMailGroupId)
		const currentAttachments = await this.getAttachmentIds(draft)
		const replyTos = await this.getReplyTos(draft)

		const sk = decryptKey(mailGroupKey, draft._ownerEncSessionKey as any)
		const service = createDraftUpdateData({
			draft: draft._id,
			draftData: createDraftData({
				subject: subject,
				compressedBodyText: body,
				senderMailAddress: senderMailAddress,
				senderName: senderName,
				confidential: confidential,
				method: draft.method,
				toRecipients: toRecipients.map(recipientToDraftRecipient),
				ccRecipients: ccRecipients.map(recipientToDraftRecipient),
				bccRecipients: bccRecipients.map(recipientToDraftRecipient),
				replyTos: replyTos,
				removedAttachments: this._getRemovedAttachments(attachments, currentAttachments),
				addedAttachments: await this._createAddedAttachments(attachments, currentAttachments, senderMailGroupId, mailGroupKey),
				bodyText: "",
			}),
		})
		this.deferredDraftId = draft._id
		// we have to wait for the updated mail because sendMail() might be called right after this update
		this.deferredDraftUpdate = defer()
		// use a local reference here because this._deferredDraftUpdate is set to null when the event is received async
		const deferredUpdatePromiseWrapper = this.deferredDraftUpdate
		await this.serviceExecutor.put(DraftService, service, { sessionKey: sk })
		return deferredUpdatePromiseWrapper.promise
	}

	async moveMails(mails: IdTuple[], targetFolder: IdTuple): Promise<void> {
		await this.serviceExecutor.post(MoveMailService, createMoveMailData({ mails, targetFolder }))
	}

	async reportMail(mail: Mail, reportType: MailReportType): Promise<void> {
		const mailSessionKey: Aes128Key = assertNotNull(await this.crypto.resolveSessionKeyForInstance(mail))
		const postData = createReportMailPostData({
			mailId: mail._id,
			mailSessionKey: bitArrayToUint8Array(mailSessionKey),
			reportType,
		})
		await this.serviceExecutor.post(ReportMailService, postData)
	}

	async deleteMails(mails: IdTuple[], folder: IdTuple): Promise<void> {
		const deleteMailData = createDeleteMailData({
			mails,
			folder,
		})
		await this.serviceExecutor.delete(MailService, deleteMailData)
	}

	/**
	 * Returns all ids of the files that have been removed, i.e. that are contained in the existingFileIds but not in the provided files
	 */
	_getRemovedAttachments(providedFiles: Attachments | null, existingFileIds: IdTuple[]): IdTuple[] {
		let removedAttachmentIds: IdTuple[] = []

		if (providedFiles != null) {
			let attachments = providedFiles
			// check which attachments have been removed
			for (const fileId of existingFileIds) {
				if (
					!attachments.some(
						(attachment) => attachment._type !== "DataFile" && attachment._type !== "FileReference" && isSameId(getLetId(attachment), fileId),
					)
				) {
					removedAttachmentIds.push(fileId)
				}
			}
		}

		return removedAttachmentIds
	}

	/**
	 * Uploads the given data files or sets the file if it is already existing files (e.g. forwarded files) and returns all DraftAttachments
	 */
	async _createAddedAttachments(
		providedFiles: Attachments | null,
		existingFileIds: ReadonlyArray<IdTuple>,
		senderMailGroupId: Id,
		mailGroupKey: Aes128Key,
	): Promise<DraftAttachment[]> {
		if (providedFiles == null || providedFiles.length === 0) return []

		// Verify mime types are correct before uploading
		validateMimeTypesForAttachments(providedFiles)

		return promiseMap(providedFiles, async (providedFile) => {
			// check if this is a new attachment or an existing one
			if (isDataFile(providedFile)) {
				// user added attachment
				const fileSessionKey = aes256RandomKey()
				let referenceTokens: Array<BlobReferenceTokenWrapper>
				if (isApp() || isDesktop()) {
					const { location } = await this.fileApp.writeDataFile(providedFile)
					referenceTokens = await this.blobFacade.encryptAndUploadNative(ArchiveDataType.Attachments, location, senderMailGroupId, fileSessionKey)
					await this.fileApp.deleteFile(location)
				} else {
					referenceTokens = await this.blobFacade.encryptAndUpload(ArchiveDataType.Attachments, providedFile.data, senderMailGroupId, fileSessionKey)
				}
				return this.createAndEncryptDraftAttachment(referenceTokens, fileSessionKey, providedFile, mailGroupKey)
			} else if (isFileReference(providedFile)) {
				const fileSessionKey = aes256RandomKey()
				const referenceTokens = await this.blobFacade.encryptAndUploadNative(
					ArchiveDataType.Attachments,
					providedFile.location,
					senderMailGroupId,
					fileSessionKey,
				)
				return this.createAndEncryptDraftAttachment(referenceTokens, fileSessionKey, providedFile, mailGroupKey)
			} else if (!containsId(existingFileIds, getLetId(providedFile))) {
				// forwarded attachment which was not in the draft before
				return this.crypto.resolveSessionKeyForInstance(providedFile).then((fileSessionKey) => {
					const attachment = createDraftAttachment({
						existingFile: getLetId(providedFile),
						ownerEncFileSessionKey: encryptKey(mailGroupKey, assertNotNull(fileSessionKey, "filesessionkey was not resolved")),
						newFile: null,
					})
					return attachment
				})
			} else {
				return null
			}
		}) // disable concurrent file upload to avoid timeout because of missing progress events on Firefox.
			.then((attachments) => attachments.filter(isNotNull))
			.then((it) => {
				// only delete the temporary files after all attachments have been uploaded
				if (isApp()) {
					this.fileApp.clearFileData().catch((e) => console.warn("Failed to clear files", e))
				}

				return it
			})
	}

	private createAndEncryptDraftAttachment(
		referenceTokens: BlobReferenceTokenWrapper[],
		fileSessionKey: Aes128Key,
		providedFile: DataFile | FileReference,
		mailGroupKey: Aes128Key,
	): DraftAttachment {
		return createDraftAttachment({
			newFile: createNewDraftAttachment({
				encFileName: encryptString(fileSessionKey, providedFile.name),
				encMimeType: encryptString(fileSessionKey, providedFile.mimeType),
				referenceTokens: referenceTokens,
				encCid: providedFile.cid == null ? null : encryptString(fileSessionKey, providedFile.cid),
			}),
			ownerEncFileSessionKey: encryptKey(mailGroupKey, fileSessionKey),
			existingFile: null,
		})
	}

	async sendDraft(draft: Mail, recipients: Array<Recipient>, language: string): Promise<void> {
		const senderMailGroupId = await this._getMailGroupIdForMailAddress(this.userFacade.getLoggedInUser(), draft.sender.address)
		const bucketKey = aes256RandomKey()
		const sendDraftData = createSendDraftData({
			language: language,
			mail: draft._id,
			mailSessionKey: null,
			attachmentKeyData: [],
			calendarMethod: false,
			internalRecipientKeyData: [],
			plaintext: false,
			bucketEncMailSessionKey: null,
			senderNameUnencrypted: null,
			secureExternalRecipientKeyData: [],
			symEncInternalRecipientKeyData: [],
		})

		const attachments = await this.getAttachmentIds(draft)
		for (let fileId of attachments) {
			const file = await this.entityClient.load(FileTypeRef, fileId)
			const fileSessionKey = assertNotNull(await this.crypto.resolveSessionKeyForInstance(file), "fileSessionKey was null")
			const data = createAttachmentKeyData({
				file: fileId,
				fileSessionKey: null,
				bucketEncFileSessionKey: null,
			})

			if (draft.confidential) {
				data.bucketEncFileSessionKey = encryptKey(bucketKey, fileSessionKey)
			} else {
				data.fileSessionKey = keyToUint8Array(fileSessionKey)
			}

			sendDraftData.attachmentKeyData.push(data)
		}

		await Promise.all([
			this.entityClient.loadRoot(TutanotaPropertiesTypeRef, this.userFacade.getUserGroupId()).then((tutanotaProperties) => {
				sendDraftData.plaintext = tutanotaProperties.sendPlaintextOnly
			}),
			this.crypto.resolveSessionKeyForInstance(draft).then((mailSessionkey) => {
				let sk = assertNotNull(mailSessionkey, "mailSessionKey was null")
				sendDraftData.calendarMethod = draft.method !== MailMethod.NONE

				if (draft.confidential) {
					sendDraftData.bucketEncMailSessionKey = encryptKey(bucketKey, sk)
					const hasExternalSecureRecipient = recipients.some((r) => r.type === RecipientType.EXTERNAL && !!this.getContactPassword(r.contact)?.trim())

					if (hasExternalSecureRecipient) {
						sendDraftData.senderNameUnencrypted = draft.sender.name // needed for notification mail
					}

					return this._addRecipientKeyData(bucketKey, sendDraftData, recipients, senderMailGroupId)
				} else {
					sendDraftData.mailSessionKey = bitArrayToUint8Array(sk)
				}
			}),
		])
		await this.serviceExecutor.post(SendDraftService, sendDraftData)
	}

	async getAttachmentIds(draft: Mail): Promise<IdTuple[]> {
		return draft.attachments
	}

	async getReplyTos(draft: Mail): Promise<EncryptedMailAddress[]> {
		if (isLegacyMail(draft)) {
			return draft.replyTos
		} else {
			const ownerEncSessionKeyProvider: OwnerEncSessionKeyProvider = async (instanceElementId: Id) => assertNotNull(draft._ownerEncSessionKey)
			const mailDetailsDraftId = assertNotNull(draft.mailDetailsDraft, "draft without mailDetailsDraft")
			const mailDetails = await this.entityClient.loadMultiple(
				MailDetailsDraftTypeRef,
				listIdPart(mailDetailsDraftId),
				[elementIdPart(mailDetailsDraftId)],
				ownerEncSessionKeyProvider,
			)
			if (mailDetails.length === 0) {
				throw new NotFoundError(`MailDetailsDraft ${draft.mailDetailsDraft}`)
			}
			return mailDetails[0].details.replyTos
		}
	}

	async checkMailForPhishing(
		mail: Mail,
		links: Array<{
			href: string
			innerHTML: string
		}>,
	): Promise<boolean> {
		let score = 0
		const senderAddress = mail.sender.address

		let senderAuthenticated
		if (mail.authStatus !== null) {
			senderAuthenticated = mail.authStatus === MailAuthenticationStatus.AUTHENTICATED
		} else if (!isLegacyMail(mail)) {
			const mailDetails = await this.loadMailDetailsBlob(mail)
			senderAuthenticated = mailDetails.authStatus === MailAuthenticationStatus.AUTHENTICATED
		} else {
			senderAuthenticated = false
		}

		if (senderAuthenticated) {
			if (this._checkFieldForPhishing(ReportedMailFieldType.FROM_ADDRESS, senderAddress)) {
				score += 6
			} else {
				const senderDomain = addressDomain(senderAddress)

				if (this._checkFieldForPhishing(ReportedMailFieldType.FROM_DOMAIN, senderDomain)) {
					score += 6
				}
			}
		} else {
			if (this._checkFieldForPhishing(ReportedMailFieldType.FROM_ADDRESS_NON_AUTH, senderAddress)) {
				score += 6
			} else {
				const senderDomain = addressDomain(senderAddress)

				if (this._checkFieldForPhishing(ReportedMailFieldType.FROM_DOMAIN_NON_AUTH, senderDomain)) {
					score += 6
				}
			}
		}

		// We check that subject exists because when there's an encryption error it will be missing
		if (mail.subject && this._checkFieldForPhishing(ReportedMailFieldType.SUBJECT, mail.subject)) {
			score += 3
		}

		for (const link of links) {
			if (this._checkFieldForPhishing(ReportedMailFieldType.LINK, link.href)) {
				score += 6
				break
			} else {
				const domain = getUrlDomain(link.href)

				if (domain && this._checkFieldForPhishing(ReportedMailFieldType.LINK_DOMAIN, domain)) {
					score += 6
					break
				}
			}
		}

		const hasSuspiciousLink = links.some(({ href, innerHTML }) => {
			const innerText = htmlToText(innerHTML)
			const textUrl = parseUrl(innerText)
			const hrefUrl = parseUrl(href)
			return textUrl && hrefUrl && textUrl.hostname !== hrefUrl.hostname
		})

		if (hasSuspiciousLink) {
			score += 6
		}

		return Promise.resolve(7 < score)
	}

	async deleteFolder(id: IdTuple): Promise<void> {
		const deleteMailFolderData = createDeleteMailFolderData({
			folders: [id],
		})
		// TODO make DeleteMailFolderData unencrypted in next model version
		await this.serviceExecutor.delete(MailFolderService, deleteMailFolderData, { sessionKey: "dummy" as any })
	}

	async fixupCounterForMailList(groupId: Id, listId: Id, unreadMails: number): Promise<void> {
		const data = createWriteCounterData({
			counterType: CounterType.UnreadMails,
			row: groupId,
			column: listId,
			value: String(unreadMails),
		})
		await this.serviceExecutor.post(CounterService, data)
	}

	_checkFieldForPhishing(type: ReportedMailFieldType, value: string): boolean {
		const hash = phishingMarkerValue(type, value)
		return this.phishingMarkers.has(hash)
	}

	async _addRecipientKeyData(bucketKey: Aes128Key, sendDraftData: SendDraftData, recipients: Array<Recipient>, senderMailGroupId: Id): Promise<void> {
		const notFoundRecipients: string[] = []

		for (let recipient of recipients) {
			if (recipient.address === SYSTEM_GROUP_MAIL_ADDRESS || !recipient) {
				notFoundRecipients.push(recipient.address)
				continue
			}

			// copy password information if this is an external contact
			// otherwise load the key information from the server
			const isSharedMailboxSender = !isSameId(this.userFacade.getGroupId(GroupType.Mail), senderMailGroupId)

			if (recipient.type === RecipientType.EXTERNAL) {
				const password = this.getContactPassword(recipient.contact)
				if (password == null || isSharedMailboxSender) {
					// no password given and prevent sending to secure externals from shared group
					notFoundRecipients.push(recipient.address)
					continue
				}

				const salt = generateRandomSalt()
				const kdfVersion = DEFAULT_KDF_TYPE
				const passwordKey = await this.loginFacade.deriveUserPassphraseKey(kdfVersion, password, salt)
				const passwordVerifier = createAuthVerifier(passwordKey)
				const externalGroupKeys = await this._getExternalGroupKey(recipient.address, passwordKey, passwordVerifier)
				const data = createSecureExternalRecipientKeyData({
					mailAddress: recipient.address,
					symEncBucketKey: null, // legacy for old permission system, not used anymore
					kdfVersion: kdfVersion,
					ownerEncBucketKey: encryptKey(externalGroupKeys.externalMailGroupKey, bucketKey),
					passwordVerifier: passwordVerifier,
					salt: salt,
					saltHash: sha256Hash(salt),
					pwEncCommunicationKey: encryptKey(passwordKey, externalGroupKeys.externalUserGroupKey),
					autoTransmitPassword: null,
					passwordChannelPhoneNumbers: [],
				})
				sendDraftData.secureExternalRecipientKeyData.push(data)
			} else {
				const keyData = await this.crypto.encryptBucketKeyForInternalRecipient(
					isSharedMailboxSender ? senderMailGroupId : this.userFacade.getLoggedInUser().userGroup.group,
					bucketKey,
					recipient.address,
					notFoundRecipients,
				)
				if (keyData == null) {
					// cannot add recipient because of notFoundError
					// we do not throw here because we want to collect all not found recipients first
				} else if (isSameTypeRef(keyData._type, SymEncInternalRecipientKeyDataTypeRef)) {
					sendDraftData.symEncInternalRecipientKeyData.push(keyData as SymEncInternalRecipientKeyData)
				} else if (isSameTypeRef(keyData._type, InternalRecipientKeyDataTypeRef)) {
					sendDraftData.internalRecipientKeyData.push(keyData as InternalRecipientKeyData)
				}
			}
		}

		if (notFoundRecipients.length > 0) {
			throw new RecipientsNotFoundError(notFoundRecipients.join("\n"))
		}
	}

	private getContactPassword(contact: Contact | null): string | null {
		return contact?.presharedPassword ?? contact?.autoTransmitPassword ?? null
	}

	/**
	 * Checks that an external user instance with a mail box exists for the given recipient. If it does not exist, it is created.
	 * Returns the user group key and the user mail group key of the external recipient.
	 * @param recipientMailAddress
	 * @param externalUserPwKey The external user's password key.
	 * @param verifier The external user's verifier, base64 encoded.
	 * @return Resolves to the the external user's group key and the external user's mail group key, rejected if an error occured
	 */
	_getExternalGroupKey(
		recipientMailAddress: string,
		externalUserPwKey: Aes128Key,
		verifier: Uint8Array,
	): Promise<{
		externalUserGroupKey: Aes128Key
		externalMailGroupKey: Aes128Key
	}> {
		return this.entityClient.loadRoot(GroupRootTypeRef, this.userFacade.getUserGroupId()).then((groupRoot) => {
			let cleanedMailAddress = recipientMailAddress.trim().toLocaleLowerCase()
			let mailAddressId = stringToCustomId(cleanedMailAddress)
			return this.entityClient
				.load(ExternalUserReferenceTypeRef, [groupRoot.externalUserReferences, mailAddressId])
				.then((externalUserReference) => {
					return this.entityClient.load(UserTypeRef, externalUserReference.user).then((externalUser) => {
						let mailGroupId = assertNotNull(
							externalUser.memberships.find((m) => m.groupType === GroupType.Mail),
							"no mail group membership on external user",
						).group
						return Promise.all([
							this.entityClient.load(GroupTypeRef, mailGroupId),
							this.entityClient.load(GroupTypeRef, externalUserReference.userGroup),
						]).then(([externalMailGroup, externalUserGroup]) => {
							const userAdminKey = assertNotNull(externalUserGroup.adminGroupEncGKey, "no adminGroupEncGKey on external user group")
							const mailAdminKey = assertNotNull(externalMailGroup.adminGroupEncGKey, "no adminGroupEncGKey on external mail group")
							let externalUserGroupKey = decryptKey(this.userFacade.getUserGroupKey(), userAdminKey)
							let externalMailGroupKey = decryptKey(externalUserGroupKey, mailAdminKey)
							return {
								externalUserGroupKey,
								externalMailGroupKey,
							}
						})
					})
				})
				.catch(
					ofClass(NotFoundError, (e) => {
						// it does not exist, so create it
						let internalMailGroupKey = this.userFacade.getGroupKey(this.userFacade.getGroupId(GroupType.Mail))

						let externalUserGroupKey = aes256RandomKey()
						let externalMailGroupKey = aes256RandomKey()
						let externalUserGroupInfoSessionKey = aes256RandomKey()
						let externalMailGroupInfoSessionKey = aes256RandomKey()
						let clientKey = aes256RandomKey()
						let tutanotaPropertiesSessionKey = aes256RandomKey()
						let mailboxSessionKey = aes256RandomKey()
						let userEncEntropy = encryptBytes(externalUserGroupKey, random.generateRandomData(32))
						let userGroupData = createCreateExternalUserGroupData({
							mailAddress: cleanedMailAddress,
							externalPwEncUserGroupKey: encryptKey(externalUserPwKey, externalUserGroupKey),
							internalUserEncUserGroupKey: encryptKey(this.userFacade.getUserGroupKey(), externalUserGroupKey),
						})
						let d = createExternalUserData({
							verifier: verifier,
							userEncClientKey: encryptKey(externalUserGroupKey, clientKey),
							externalUserEncUserGroupInfoSessionKey: encryptKey(externalUserGroupKey, externalUserGroupInfoSessionKey),
							internalMailEncUserGroupInfoSessionKey: encryptKey(internalMailGroupKey, externalUserGroupInfoSessionKey),
							externalUserEncMailGroupKey: encryptKey(externalUserGroupKey, externalMailGroupKey),
							externalMailEncMailGroupInfoSessionKey: encryptKey(externalMailGroupKey, externalMailGroupInfoSessionKey),
							internalMailEncMailGroupInfoSessionKey: encryptKey(internalMailGroupKey, externalMailGroupInfoSessionKey),
							externalUserEncEntropy: userEncEntropy,
							externalUserEncTutanotaPropertiesSessionKey: encryptKey(externalUserGroupKey, tutanotaPropertiesSessionKey),
							externalMailEncMailBoxSessionKey: encryptKey(externalMailGroupKey, mailboxSessionKey),
							userGroupData: userGroupData,
							kdfVersion: "0",
						})
						return this.serviceExecutor.post(ExternalUserService, d).then(() => {
							return {
								externalUserGroupKey: externalUserGroupKey,
								externalMailGroupKey: externalMailGroupKey,
							}
						})
					}),
				)
		})
	}

	entityEventsReceived(data: EntityUpdate[]): Promise<void> {
		return promiseMap(data, (update) => {
			if (
				this.deferredDraftUpdate != null &&
				this.deferredDraftId != null &&
				update.operation === OperationType.UPDATE &&
				isSameTypeRefByAttr(MailTypeRef, update.application, update.type) &&
				isSameId(this.deferredDraftId, [update.instanceListId, update.instanceId])
			) {
				return this.entityClient.load(MailTypeRef, this.deferredDraftId).then((mail) => {
					let deferredPromiseWrapper = assertNotNull(this.deferredDraftUpdate, "deferredDraftUpdate went away?")
					this.deferredDraftUpdate = null
					deferredPromiseWrapper.resolve(mail)
				})
			}
		}).then(noOp)
	}

	/**
	 * @param markers only phishing (not spam) markers will be sent as event bus updates
	 */
	phishingMarkersUpdateReceived(markers: ReportedMailFieldMarker[]) {
		for (const marker of markers) {
			if (marker.status === PhishingMarkerStatus.INACTIVE) {
				this.phishingMarkers.delete(marker.marker)
			} else {
				this.phishingMarkers.add(marker.marker)
			}
		}
	}

	getRecipientKeyData(mailAddress: string): Promise<PublicKeyGetOut | null> {
		return this.serviceExecutor
			.get(
				PublicKeyService,
				createPublicKeyGetIn({
					mailAddress,
				}),
			)
			.catch(ofClass(NotFoundError, () => null))
	}

	_getMailGroupIdForMailAddress(user: User, mailAddress: string): Promise<Id> {
		return promiseFilter(getUserGroupMemberships(user, GroupType.Mail), (groupMembership) => {
			return this.entityClient.load(GroupTypeRef, groupMembership.group).then((mailGroup) => {
				if (mailGroup.user == null) {
					return this.entityClient.load(GroupInfoTypeRef, groupMembership.groupInfo).then((mailGroupInfo) => {
						return contains(getEnabledMailAddressesForGroupInfo(mailGroupInfo), mailAddress)
					})
				} else if (isSameId(mailGroup.user, user._id)) {
					return this.entityClient.load(GroupInfoTypeRef, user.userGroup.groupInfo).then((userGroupInfo) => {
						return contains(getEnabledMailAddressesForGroupInfo(userGroupInfo), mailAddress)
					})
				} else {
					// not supported
					return false
				}
			})
		}).then((filteredMemberships) => {
			if (filteredMemberships.length === 1) {
				return filteredMemberships[0].group
			} else {
				throw new NotFoundError("group for mail address not found " + mailAddress)
			}
		})
	}

	async clearFolder(folderId: IdTuple) {
		const deleteMailData = createDeleteMailData({
			folder: folderId,
			mails: [],
		})
		await this.serviceExecutor.delete(MailService, deleteMailData)
	}

	async unsubscribe(mailId: IdTuple, recipient: string, headers: string[]) {
		const postData = createListUnsubscribeData({
			mail: mailId,
			recipient,
			headers: headers.join("\n"),
		})
		await this.serviceExecutor.post(ListUnsubscribeService, postData)
	}

	async loadAttachments(mail: Mail): Promise<TutanotaFile[]> {
		if (mail.attachments.length === 0) {
			return []
		}
		const attachmentsListId = listIdPart(mail.attachments[0])
		const attachmentElementIds = mail.attachments.map(elementIdPart)

		const bucketKey = mail.bucketKey
		let ownerEncSessionKeyProvider: OwnerEncSessionKeyProvider | undefined
		if (bucketKey) {
			const mailOwnerGroupId = assertNotNull(mail._ownerGroup)
			const typeModel = await resolveTypeReference(FileTypeRef)
			const decBucketKey = lazyMemoized(() => this.crypto.resolveWithBucketKey(assertNotNull(mail.bucketKey), mail, typeModel))
			ownerEncSessionKeyProvider = async (instanceElementId: Id) => {
				const instanceSessionKey = assertNotNull(
					bucketKey.bucketEncSessionKeys.find((instanceSessionKey) => instanceElementId === instanceSessionKey.instanceId),
				)
				const decryptedSessionKey = decryptKey(await decBucketKey(), instanceSessionKey.symEncSessionKey)
				return encryptKey(this.userFacade.getGroupKey(mailOwnerGroupId), decryptedSessionKey)
			}
		}
		return await this.entityClient.loadMultiple(FileTypeRef, attachmentsListId, attachmentElementIds, ownerEncSessionKeyProvider)
	}

	/**
	 * @param mail in case it is a mailDetailsBlob
	 */
	async loadMailDetailsBlob(mail: Mail): Promise<MailDetails> {
		if (isLegacyMail(mail) || isDetailsDraft(mail)) {
			throw new ProgrammingError("not supported, must be mail details blob")
		} else {
			const mailDetailsBlobId = assertNotNull(mail.mailDetails)

			const mailDetailsBlobs = await this.entityClient.loadMultiple(
				MailDetailsBlobTypeRef,
				listIdPart(mailDetailsBlobId),
				[elementIdPart(mailDetailsBlobId)],
				async () => assertNotNull(mail._ownerEncSessionKey),
			)
			if (mailDetailsBlobs.length === 0) {
				throw new NotFoundError(`MailDetailsBlob ${mailDetailsBlobId}`)
			}
			return mailDetailsBlobs[0].details
		}
	}

	/**
	 * @param mail in case it is a mailDetailsDraft
	 */
	async loadMailDetailsDraft(mail: Mail): Promise<MailDetails> {
		if (isLegacyMail(mail) || !isDetailsDraft(mail)) {
			throw new ProgrammingError("not supported, must be mail details draft")
		} else {
			const detailsDraftId = assertNotNull(mail.mailDetailsDraft)

			const mailDetailsDrafts = await this.entityClient.loadMultiple(
				MailDetailsDraftTypeRef,
				listIdPart(detailsDraftId),
				[elementIdPart(detailsDraftId)],
				async () => assertNotNull(mail._ownerEncSessionKey),
			)
			if (mailDetailsDrafts.length === 0) {
				throw new NotFoundError(`MailDetailsDraft ${detailsDraftId}`)
			}
			return mailDetailsDrafts[0].details
		}
	}
}

export function phishingMarkerValue(type: ReportedMailFieldType, value: string): string {
	return type + murmurHash(value.replace(/\s/g, ""))
}

function parseUrl(link: string): URL | null {
	try {
		return new URL(link)
	} catch (e) {
		return null
	}
}

function getUrlDomain(link: string): string | null {
	const url = parseUrl(link)
	return url && url.hostname
}

function recipientToDraftRecipient(recipient: PartialRecipient): DraftRecipient {
	return createDraftRecipient({
		name: recipient.name ?? "",
		mailAddress: recipient.address,
	})
}

function recipientToEncryptedMailAddress(recipient: PartialRecipient): EncryptedMailAddress {
	return createEncryptedMailAddress({
		name: recipient.name ?? "",
		address: recipient.address,
	})
}

/**
 * Verify all attachments contain correctly formatted MIME types. This ensures that they can be sent.
 *
 * Note that this does not verify that the mime type actually corresponds to a known MIME type.
 * @param attachments
 * @throws {ProgrammingError} if a MIME type is somehow not correctly formatted for at least one attachment
 */
export function validateMimeTypesForAttachments(attachments: Attachments) {
	const regex = /^\w+\/[\w.+-]+?(;\s*[\w.+-]+=([\w.+-]+|"[\w\s,.+-]+"))*$/g
	for (const attachment of attachments) {
		if (isDataFile(attachment) || isFileReference(attachment)) {
			if (!attachment.mimeType.match(regex)) {
				throw new ProgrammingError(`${attachment.mimeType} is not a correctly formatted mimetype (${attachment.name})`)
			}
		}
	}
}
