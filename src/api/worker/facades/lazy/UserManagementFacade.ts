import { AccountType, asKdfType, Const, CounterType, DEFAULT_KDF_TYPE, GroupType } from "../../../common/TutanotaConstants.js"
import type { User } from "../../../entities/sys/TypeRefs.js"
import {
	createMembershipAddData,
	createRecoverCode,
	createResetPasswordData,
	createUpdateAdminshipData,
	createUserDataDelete,
	GroupTypeRef,
	RecoverCodeTypeRef,
} from "../../../entities/sys/TypeRefs.js"
import { encryptBytes, encryptString } from "../../crypto/CryptoFacade.js"
import { assertNotNull, neverNull, uint8ArrayToHex } from "@tutao/tutanota-utils"
import type { UserAccountUserData } from "../../../entities/tutanota/TypeRefs.js"
import { createUserAccountCreateData, createUserAccountUserData } from "../../../entities/tutanota/TypeRefs.js"
import type { GroupManagementFacade } from "./GroupManagementFacade.js"
import type { RecoverData } from "../LoginFacade.js"
import { LoginFacade } from "../LoginFacade.js"
import { CounterFacade } from "./CounterFacade.js"
import { assertWorkerOrNode } from "../../../common/Env.js"
import {
	aes256RandomKey,
	bitArrayToUint8Array,
	createAuthVerifier,
	createAuthVerifierAsBase64Url,
	decryptKey,
	encryptKey,
	generateRandomSalt,
	random,
} from "@tutao/tutanota-crypto"
import type { RsaImplementation } from "../../crypto/RsaImplementation.js"
import { EntityClient } from "../../../common/EntityClient.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { MembershipService, ResetPasswordService, SystemKeysService, UpdateAdminshipService, UserService } from "../../../entities/sys/Services.js"
import { UserAccountService } from "../../../entities/tutanota/Services.js"
import { UserFacade } from "../UserFacade.js"
import { ExposedOperationProgressTracker, OperationId } from "../../../main/OperationProgressTracker.js"

assertWorkerOrNode()

export class UserManagementFacade {
	constructor(
		private readonly userFacade: UserFacade,
		private readonly groupManagement: GroupManagementFacade,
		private readonly counters: CounterFacade,
		private readonly rsa: RsaImplementation,
		private readonly entityClient: EntityClient,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly operationProgressTracker: ExposedOperationProgressTracker,
		private readonly loginFacade: LoginFacade,
	) {}

	async changeUserPassword(user: User, newPassword: string): Promise<void> {
		const userGroupKey = await this.groupManagement.getGroupKeyViaAdminEncGKey(user.userGroup.group)
		const salt = generateRandomSalt()
		const kdfVersion = DEFAULT_KDF_TYPE
		const passwordKey = await this.loginFacade.deriveUserPassphraseKey(kdfVersion, newPassword, salt)
		const pwEncUserGroupKey = encryptKey(passwordKey, userGroupKey)
		const passwordVerifier = createAuthVerifier(passwordKey)
		const data = createResetPasswordData({
			user: user._id,
			salt,
			verifier: passwordVerifier,
			pwEncUserGroupKey,
			kdfVersion,
		})
		await this.serviceExecutor.post(ResetPasswordService, data)
	}

	async changeAdminFlag(user: User, admin: boolean): Promise<void> {
		let adminGroupId = this.userFacade.getGroupId(GroupType.Admin)

		let adminGroupKey = this.userFacade.getGroupKey(adminGroupId)

		const userGroup = await this.entityClient.load(GroupTypeRef, user.userGroup.group)
		let userGroupKey = decryptKey(adminGroupKey, neverNull(userGroup.adminGroupEncGKey))

		if (admin) {
			await this.groupManagement.addUserToGroup(user, adminGroupId)

			if (user.accountType !== AccountType.SYSTEM) {
				const keyData = await this._getAccountKeyData()
				// we can not use addUserToGroup here because the admin is not admin of the account group
				const addAccountGroup = createMembershipAddData({
					user: user._id,
					group: keyData.group,
					symEncGKey: encryptKey(userGroupKey, decryptKey(this.userFacade.getUserGroupKey(), keyData.symEncGKey)),
				})
				await this.serviceExecutor.post(MembershipService, addAccountGroup)
			}
		} else {
			await this.groupManagement.removeUserFromGroup(user._id, adminGroupId)

			if (user.accountType !== AccountType.SYSTEM) {
				const keyData = await this._getAccountKeyData()
				return this.groupManagement.removeUserFromGroup(user._id, keyData.group)
			}
		}
	}

	/**
	 * Get key and id of premium or starter group.
	 * @throws Error if account type is not premium or starter
	 *
	 * @private
	 */
	async _getAccountKeyData(): Promise<{ group: Id; symEncGKey: Uint8Array }> {
		const keysReturn = await this.serviceExecutor.get(SystemKeysService, null)
		const user = this.userFacade.getLoggedInUser()

		if (user.accountType === AccountType.PAID) {
			return {
				group: neverNull(keysReturn.premiumGroup),
				symEncGKey: keysReturn.premiumGroupKey,
			}
		} else if (user.accountType === AccountType.STARTER) {
			// We don't have starterGroup on SystemKeyReturn so we hardcode it for now.
			return {
				group: "JDpWrwG----0",
				symEncGKey: keysReturn.starterGroupKey,
			}
		} else {
			throw new Error(`Trying to get keyData for user with account type ${user.accountType}`)
		}
	}

	async updateAdminship(groupId: Id, newAdminGroupId: Id): Promise<void> {
		let adminGroupId = this.userFacade.getGroupId(GroupType.Admin)
		const newAdminGroup = await this.entityClient.load(GroupTypeRef, newAdminGroupId)
		const group = await this.entityClient.load(GroupTypeRef, groupId)
		const oldAdminGroup = await this.entityClient.load(GroupTypeRef, neverNull(group.admin))

		const adminGroupKey = this.userFacade.getGroupKey(adminGroupId)

		let groupKey
		if (oldAdminGroup._id === adminGroupId) {
			groupKey = decryptKey(adminGroupKey, neverNull(group.adminGroupEncGKey))
		} else {
			let localAdminGroupKey = decryptKey(adminGroupKey, neverNull(oldAdminGroup.adminGroupEncGKey))
			groupKey = decryptKey(localAdminGroupKey, neverNull(group.adminGroupEncGKey))
		}

		let newAdminGroupEncGKey
		if (newAdminGroup._id === adminGroupId) {
			newAdminGroupEncGKey = encryptKey(adminGroupKey, groupKey)
		} else {
			let localAdminGroupKey = decryptKey(adminGroupKey, neverNull(newAdminGroup.adminGroupEncGKey))
			newAdminGroupEncGKey = encryptKey(localAdminGroupKey, groupKey)
		}

		const data = createUpdateAdminshipData({
			group: group._id,
			newAdminGroup: newAdminGroup._id,
			newAdminGroupEncGKey,
		})
		await this.serviceExecutor.post(UpdateAdminshipService, data)
	}

	async readUsedUserStorage(user: User): Promise<number> {
		const counterValue = await this.counters.readCounterValue(CounterType.UserStorageLegacy, neverNull(user.customer), user.userGroup.group)
		return Number(counterValue)
	}

	async deleteUser(user: User, restore: boolean): Promise<void> {
		const data = createUserDataDelete({
			user: user._id,
			restore,
			date: Const.CURRENT_DATE,
		})
		await this.serviceExecutor.delete(UserService, data)
	}

	_getGroupId(user: User, groupType: GroupType): Id {
		if (groupType === GroupType.User) {
			return user.userGroup.group
		} else {
			let membership = user.memberships.find((m) => m.groupType === groupType)

			if (!membership) {
				throw new Error("could not find groupType " + groupType + " for user " + user._id)
			}

			return membership.group
		}
	}

	async createUser(
		name: string,
		mailAddress: string,
		password: string,
		userIndex: number,
		overallNbrOfUsersToCreate: number,
		operationId: OperationId,
	): Promise<void> {
		let adminGroupIds = this.userFacade.getGroupIds(GroupType.Admin)

		if (adminGroupIds.length === 0) {
			adminGroupIds = this.userFacade.getGroupIds(GroupType.LocalAdmin)
		}

		const adminGroupId = adminGroupIds[0]

		const adminGroupKey = this.userFacade.getGroupKey(adminGroupId)

		const customerGroupKey = this.userFacade.getGroupKey(this.userFacade.getGroupId(GroupType.Customer))

		const userGroupKey = aes256RandomKey()
		const userGroupInfoSessionKey = aes256RandomKey()
		const keyPair = await this.rsa.generateKey()
		const userGroupData = await this.groupManagement.generateInternalGroupData(
			keyPair,
			userGroupKey,
			userGroupInfoSessionKey,
			adminGroupId,
			adminGroupKey,
			customerGroupKey,
		)
		await this.operationProgressTracker.onProgress(operationId, ((userIndex + 0.8) / overallNbrOfUsersToCreate) * 100)

		let data = createUserAccountCreateData({
			date: Const.CURRENT_DATE,
			userGroupData: userGroupData,
			userData: await this.generateUserAccountData(
				userGroupKey,
				userGroupInfoSessionKey,
				customerGroupKey,
				mailAddress,
				password,
				name,
				this.generateRecoveryCode(userGroupKey),
			),
		})
		await this.serviceExecutor.post(UserAccountService, data)
		return this.operationProgressTracker.onProgress(operationId, ((userIndex + 1) / overallNbrOfUsersToCreate) * 100)
	}

	async generateUserAccountData(
		userGroupKey: Aes128Key,
		userGroupInfoSessionKey: Aes128Key,
		customerGroupKey: Aes128Key,
		mailAddress: string,
		password: string,
		userName: string,
		recoverData: RecoverData,
	): Promise<UserAccountUserData> {
		const salt = generateRandomSalt()
		const kdfType = DEFAULT_KDF_TYPE
		const userPassphraseKey = await this.loginFacade.deriveUserPassphraseKey(kdfType, password, salt)
		const mailGroupKey = aes256RandomKey()
		const contactGroupKey = aes256RandomKey()
		const fileGroupKey = aes256RandomKey()
		const clientKey = aes256RandomKey()
		const mailboxSessionKey = aes256RandomKey()
		const contactListSessionKey = aes256RandomKey()
		const fileSystemSessionKey = aes256RandomKey()
		const mailGroupInfoSessionKey = aes256RandomKey()
		const contactGroupInfoSessionKey = aes256RandomKey()
		const fileGroupInfoSessionKey = aes256RandomKey()
		const tutanotaPropertiesSessionKey = aes256RandomKey()
		const userEncEntropy = encryptBytes(userGroupKey, random.generateRandomData(32))
		const userData = createUserAccountUserData({
			mailAddress: mailAddress,
			encryptedName: encryptString(userGroupInfoSessionKey, userName),
			salt: salt,
			kdfVersion: kdfType,
			verifier: createAuthVerifier(userPassphraseKey),
			userEncClientKey: encryptKey(userGroupKey, clientKey),
			pwEncUserGroupKey: encryptKey(userPassphraseKey, userGroupKey),
			userEncCustomerGroupKey: encryptKey(userGroupKey, customerGroupKey),
			userEncMailGroupKey: encryptKey(userGroupKey, mailGroupKey),
			userEncContactGroupKey: encryptKey(userGroupKey, contactGroupKey),
			userEncFileGroupKey: encryptKey(userGroupKey, fileGroupKey),
			userEncEntropy: userEncEntropy,
			userEncTutanotaPropertiesSessionKey: encryptKey(userGroupKey, tutanotaPropertiesSessionKey),
			mailEncMailBoxSessionKey: encryptKey(mailGroupKey, mailboxSessionKey),
			contactEncContactListSessionKey: encryptKey(contactGroupKey, contactListSessionKey),
			fileEncFileSystemSessionKey: encryptKey(fileGroupKey, fileSystemSessionKey),
			customerEncMailGroupInfoSessionKey: encryptKey(customerGroupKey, mailGroupInfoSessionKey),
			customerEncContactGroupInfoSessionKey: encryptKey(customerGroupKey, contactGroupInfoSessionKey),
			customerEncFileGroupInfoSessionKey: encryptKey(customerGroupKey, fileGroupInfoSessionKey),
			userEncRecoverCode: recoverData.userEncRecoverCode,
			recoverCodeEncUserGroupKey: recoverData.recoverCodeEncUserGroupKey,
			recoverCodeVerifier: recoverData.recoveryCodeVerifier,
		})
		return userData
	}

	generateRecoveryCode(userGroupKey: Aes128Key): RecoverData {
		const recoveryCode = aes256RandomKey()
		const userEncRecoverCode = encryptKey(userGroupKey, recoveryCode)
		const recoverCodeEncUserGroupKey = encryptKey(recoveryCode, userGroupKey)
		const recoveryCodeVerifier = createAuthVerifier(recoveryCode)
		return {
			userEncRecoverCode,
			recoverCodeEncUserGroupKey,
			hexCode: uint8ArrayToHex(bitArrayToUint8Array(recoveryCode)),
			recoveryCodeVerifier,
		}
	}

	async getRecoverCode(password: string): Promise<string> {
		const user = this.userFacade.getLoggedInUser()
		const recoverCodeId = user.auth?.recoverCode
		if (recoverCodeId == null) {
			throw new Error("Auth is missing")
		}

		const passwordKey = await this.loginFacade.deriveUserPassphraseKey(asKdfType(user.kdfVersion), password, assertNotNull(user.salt))
		const extraHeaders = {
			authVerifier: createAuthVerifierAsBase64Url(passwordKey),
		}

		const recoveryCodeEntity = await this.entityClient.load(RecoverCodeTypeRef, recoverCodeId, undefined, extraHeaders)
		return uint8ArrayToHex(bitArrayToUint8Array(decryptKey(this.userFacade.getUserGroupKey(), recoveryCodeEntity.userEncRecoverCode)))
	}

	async createRecoveryCode(password: string): Promise<string> {
		const user = this.userFacade.getUser()

		if (user == null || user.auth == null) {
			throw new Error("Invalid state: no user or no user.auth")
		}

		const { userEncRecoverCode, recoverCodeEncUserGroupKey, hexCode, recoveryCodeVerifier } = this.generateRecoveryCode(this.userFacade.getUserGroupKey())
		const recoverPasswordEntity = createRecoverCode({
			userEncRecoverCode: userEncRecoverCode,
			recoverCodeEncUserGroupKey: recoverCodeEncUserGroupKey,
			_ownerGroup: this.userFacade.getUserGroupId(),
			verifier: recoveryCodeVerifier,
		})
		const pwKey = await this.loginFacade.deriveUserPassphraseKey(asKdfType(user.kdfVersion), password, assertNotNull(user.salt))
		const authVerifier = createAuthVerifierAsBase64Url(pwKey)
		await this.entityClient.setup(null, recoverPasswordEntity, {
			authVerifier,
		})
		return hexCode
	}
}
