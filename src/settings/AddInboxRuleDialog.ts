import m from "mithril"
import { Dialog } from "../gui/base/Dialog"
import { lang, TranslationKey } from "../misc/LanguageViewModel"
import { InboxRuleType, MailFolderType } from "../api/common/TutanotaConstants"
import { isDomainName, isMailAddress, isRegularExpression } from "../misc/FormatValidator"
import { getInboxRuleTypeNameMapping } from "../mail/model/InboxRuleHandler"
import type { InboxRule } from "../api/entities/tutanota/TypeRefs.js"
import { createInboxRule } from "../api/entities/tutanota/TypeRefs.js"
import { getExistingRuleForType, getFolderName, getIndentedFolderNameForDropdown, getPathToFolderString } from "../mail/model/MailUtils"
import type { MailboxDetail } from "../mail/model/MailModel"
import stream from "mithril/stream"
import { DropDownSelector } from "../gui/base/DropDownSelector.js"
import { TextField } from "../gui/base/TextField.js"
import { neverNull } from "@tutao/tutanota-utils"
import { LockedError } from "../api/common/error/RestError"
import { showNotAvailableForFreeDialog } from "../misc/SubscriptionDialogs"
import { isSameId } from "../api/common/utils/EntityUtils"
import { assertMainOrNode } from "../api/common/Env"
import { locator } from "../api/main/MainLocator"
import { isOfflineError } from "../api/common/utils/ErrorCheckUtils.js"
import { assertSystemFolderOfType } from "../api/common/mail/CommonMailUtils.js"

assertMainOrNode()

export type InboxRuleTemplate = Pick<InboxRule, "type" | "value"> & { _id?: InboxRule["_id"]; targetFolder?: InboxRule["targetFolder"] }

export function show(mailBoxDetail: MailboxDetail, ruleOrTemplate: InboxRuleTemplate) {
	if (locator.logins.getUserController().isFreeAccount()) {
		showNotAvailableForFreeDialog()
	} else if (mailBoxDetail) {
		let targetFolders = mailBoxDetail.folders.getIndentedList().map((folderInfo) => {
			return {
				name: getIndentedFolderNameForDropdown(folderInfo),
				value: folderInfo.folder,
			}
		})
		const inboxRuleType = stream(ruleOrTemplate.type)
		const inboxRuleValue = stream(ruleOrTemplate.value)
		const selectedFolder = ruleOrTemplate.targetFolder == null ? null : mailBoxDetail.folders.getFolderById(ruleOrTemplate.targetFolder)
		const inboxRuleTarget = stream(selectedFolder ?? assertSystemFolderOfType(mailBoxDetail.folders, MailFolderType.ARCHIVE))

		let form = () => [
			m(DropDownSelector, {
				items: getInboxRuleTypeNameMapping(),
				label: "inboxRuleField_label",
				selectedValue: inboxRuleType(),
				selectionChangedHandler: inboxRuleType,
			}),
			m(TextField, {
				label: "inboxRuleValue_label",
				value: inboxRuleValue(),
				oninput: inboxRuleValue,
				helpLabel: () =>
					inboxRuleType() !== InboxRuleType.SUBJECT_CONTAINS && inboxRuleType() !== InboxRuleType.MAIL_HEADER_CONTAINS
						? lang.get("emailSenderPlaceholder_label")
						: lang.get("emptyString_msg"),
			}),
			m(DropDownSelector, {
				label: "inboxRuleTargetFolder_label",
				items: targetFolders,
				selectedValue: inboxRuleTarget(),
				selectedValueDisplay: getFolderName(inboxRuleTarget()),
				selectionChangedHandler: inboxRuleTarget,
				helpLabel: () => getPathToFolderString(mailBoxDetail.folders, inboxRuleTarget(), true),
			}),
		]

		const addInboxRuleOkAction = (dialog: Dialog) => {
			let rule = createInboxRule({
				type: inboxRuleType(),
				value: getCleanedValue(inboxRuleType(), inboxRuleValue()),
				targetFolder: inboxRuleTarget()._id,
			})
			const props = locator.logins.getUserController().props
			const inboxRules = props.inboxRules
			const ruleId = ruleOrTemplate._id
			props.inboxRules = ruleId == null ? [...inboxRules, rule] : inboxRules.map((inboxRule) => (isSameId(inboxRule._id, ruleId) ? rule : inboxRule))

			locator.entityClient
				.update(props)
				.then(() => {
					dialog.close()
				})
				.catch((error) => {
					if (isOfflineError(error)) {
						props.inboxRules = inboxRules
						//do not close
						throw error
					} else if (error instanceof LockedError) {
						dialog.close()
					} else {
						props.inboxRules = inboxRules
						dialog.close()
						throw error
					}
				})
		}

		Dialog.showActionDialog({
			title: lang.get("addInboxRule_action"),
			child: form,
			validator: () => validateInboxRuleInput(inboxRuleType(), inboxRuleValue(), ruleOrTemplate._id),
			allowOkWithReturn: true,
			okAction: addInboxRuleOkAction,
		})
	}
}

export function createInboxRuleTemplate(ruleType: string | null, value: string | null): InboxRuleTemplate {
	return {
		type: ruleType ?? InboxRuleType.FROM_EQUALS,
		value: getCleanedValue(neverNull(ruleType), value || ""),
	}
}

function validateInboxRuleInput(type: string, value: string, ruleId: Id | undefined): TranslationKey | null {
	let currentCleanedValue = getCleanedValue(type, value)

	if (currentCleanedValue === "") {
		return "inboxRuleEnterValue_msg"
	} else if (isInvalidRegex(currentCleanedValue)) {
		return "invalidRegexSyntax_msg"
	} else if (
		type !== InboxRuleType.SUBJECT_CONTAINS &&
		type !== InboxRuleType.MAIL_HEADER_CONTAINS &&
		!isRegularExpression(currentCleanedValue) &&
		!isDomainName(currentCleanedValue) &&
		!isMailAddress(currentCleanedValue, false)
	) {
		return "inboxRuleInvalidEmailAddress_msg"
	} else {
		let existingRule = getExistingRuleForType(locator.logins.getUserController().props, currentCleanedValue, type)

		if (existingRule && (!ruleId || (ruleId && !isSameId(existingRule._id, ruleId)))) {
			return "inboxRuleAlreadyExists_msg"
		}
	}

	return null
}

function getCleanedValue(type: string, value: string) {
	if (type === InboxRuleType.SUBJECT_CONTAINS || type === InboxRuleType.MAIL_HEADER_CONTAINS) {
		return value
	} else {
		return value.trim().toLowerCase()
	}
}

/**
 * @param value
 * @returns true if provided string is a regex and it's unparseable by RegExp, else false
 * @private
 */
function isInvalidRegex(value: string) {
	if (!isRegularExpression(value)) return false // not a regular expression is not an invalid regular expression

	try {
		// RegExp ctor throws a ParseError if invalid regex
		let regExp = new RegExp(value.substring(1, value.length - 1))
	} catch (e) {
		return true
	}

	return false
}
