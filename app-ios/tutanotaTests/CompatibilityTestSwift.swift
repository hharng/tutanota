import Foundation
import XCTest
@testable import tutanota

// used for testing Swift code
class CompatibilityTestSwift: XCTestCase {
  var testData: [String: Any]?

  override func setUp() async throws {
    try await super.setUp()

    let jsonUrl = Bundle(for: self.classForCoder).url(forResource: "CompatibilityTestData", withExtension: "json")!
    let jsonData = try Data.init(contentsOf: jsonUrl)
    self.testData = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
  }

  func testArgon2id() {
    // same parameters we use everywhere else
    let ARGON2ID_HASH_LENGTH: Int = 32
    let ARGON2ID_ITERATIONS: UInt = 4
    let ARGON2ID_PARALLELISM: UInt = 1
    let ARGON2ID_MEMORY_COST: UInt = 32 * 1024

    let tests = (testData!["argon2idTests"] as? [[String: String]])!
    for test in tests {
      let password = TUTEncodingConverter.string(toBytes: test["password"]!)
      let expectedHash = TUTEncodingConverter.hex(toBytes: test["keyHex"]!)
      let salt = TUTEncodingConverter.hex(toBytes: test["saltHex"]!)
      let result = try! generateArgon2idHash(ofPassword: password, ofHashLength: ARGON2ID_HASH_LENGTH, withSalt: salt, withIterations: ARGON2ID_ITERATIONS, withParallelism: ARGON2ID_PARALLELISM, withMemoryCost: ARGON2ID_MEMORY_COST)

      XCTAssertEqual(expectedHash, result)
    }
  }

  func testAes128() throws {
    try doAes(testKey: "aes128Tests", withMAC: false)

    let tests = (testData!["aes128Tests"] as? [[String: String]])!
    for test in tests {
      let key = TUTEncodingConverter.hex(toBytes: test["hexKey"]!)
      let keyToEncrypt128 = TUTEncodingConverter.hex(toBytes: test["keyToEncrypt128"]!)
      let keyToEncrypt256 = TUTEncodingConverter.hex(toBytes: test["keyToEncrypt256"]!)
      let encryptedKey128 = TUTEncodingConverter.base64(toBytes: test["encryptedKey128"]!)
      let encryptedKey256 = TUTEncodingConverter.base64(toBytes: test["encryptedKey256"]!)

      let resultingEncryptedKey128 = try aesEncryptKey(keyToEncrypt128, withKey: key)
      let resultingEncryptedKey256 = try aesEncryptKey(keyToEncrypt256, withKey: key)
      XCTAssertEqual(encryptedKey128, resultingEncryptedKey128)
      XCTAssertEqual(encryptedKey256, resultingEncryptedKey256)

      let resultingDecryptedKey128 = try aesDecryptKey(resultingEncryptedKey128, withKey: key)
      let resultingDecryptedKey256 = try aesDecryptKey(resultingEncryptedKey256, withKey: key)
      XCTAssertEqual(keyToEncrypt128, resultingDecryptedKey128)
      XCTAssertEqual(keyToEncrypt256, resultingDecryptedKey256)
    }
  }

  func testAes128Mac() throws {
    try doAes(testKey: "aes128MacTests", withMAC: true)

    // AES-128 with MAC is not used for keys, so it's not tested here
  }

  func testAes256() throws {
    try doAes(testKey: "aes256Tests", withMAC: true)

    let tests = (testData!["aes256Tests"] as? [[String: String]])!
    for test in tests {
      let key = TUTEncodingConverter.hex(toBytes: test["hexKey"]!)
      let iv = TUTEncodingConverter.base64(toBytes: test["ivBase64"]!)
      let keyToEncrypt128 = TUTEncodingConverter.hex(toBytes: test["keyToEncrypt128"]!)
      let keyToEncrypt256 = TUTEncodingConverter.hex(toBytes: test["keyToEncrypt256"]!)
      let encryptedKey128 = TUTEncodingConverter.base64(toBytes: test["encryptedKey128"]!)
      let encryptedKey256 = TUTEncodingConverter.base64(toBytes: test["encryptedKey256"]!)

      // aesEncrypt(key:withKey:) does not support passing in IVs, and AES and TUTCrypto do not currently support mocking, so we use the
      // full aesEncrypt function that the key function would've called anyway

      let resultingEncryptedKey128 = try aesEncrypt(data: keyToEncrypt128, withKey: key, withIV: iv, withPadding: false, withMAC: true)
      let resultingEncryptedKey256 = try aesEncrypt(data: keyToEncrypt256, withKey: key, withIV: iv, withPadding: false, withMAC: true)
      XCTAssertEqual(encryptedKey128, resultingEncryptedKey128)
      XCTAssertEqual(encryptedKey256, resultingEncryptedKey256)

      let resultingDecryptedKey128 = try aesDecryptKey(resultingEncryptedKey128, withKey: key)
      let resultingDecryptedKey256 = try aesDecryptKey(resultingEncryptedKey256, withKey: key)
      XCTAssertEqual(keyToEncrypt128, resultingDecryptedKey128)
      XCTAssertEqual(keyToEncrypt256, resultingDecryptedKey256)
    }
  }

  private func doAes(testKey: String, withMAC: Bool) throws {
    let tests = (testData![testKey] as? [[String: Any]])!
    for test in tests {
      let iv = TUTEncodingConverter.base64(toBytes: test["ivBase64"]! as! String)
      let plainText = TUTEncodingConverter.base64(toBytes: test["plainTextBase64"]! as! String)
      let cipherText = TUTEncodingConverter.base64(toBytes: test["cipherTextBase64"]! as! String)
      let key = TUTEncodingConverter.hex(toBytes: test["hexKey"]! as! String)

      let encrypted = try aesEncrypt(data: plainText, withKey: key, withIV: iv, withPadding: true, withMAC: withMAC)
      let decrypted = try aesDecryptData(encrypted, withKey: key)
      XCTAssertEqual(cipherText, encrypted)
      XCTAssertEqual(plainText, decrypted)
    }
  }

  func testKyber() throws {
    let tests = (testData!["kyberEncryptionTests"] as? [[String: Any]])!
    for test in tests {
      let publicKey = try kyberParsePublicKey(hex: test["publicKey"]! as! String)
      let privateKey = try kyberParsePrivateKey(hex: test["privateKey"]! as! String)
      let cipherTextBytes = TUTEncodingConverter.hex(toBytes: test["cipherText"]! as! String)
      let sharedSecretBytes = TUTEncodingConverter.hex(toBytes: test["sharedSecret"]! as! String)
      let seed = TUTEncodingConverter.hex(toBytes: test["seed"]! as! String)

      let encaps = try kyberEncapsulate(publicKey: publicKey, withSeed: seed)
      XCTAssertEqual(cipherTextBytes, encaps.ciphertext.data)
      XCTAssertEqual(sharedSecretBytes, encaps.sharedSecret.data)

      let decaps = try kyberDecapsulate(ciphertext: cipherTextBytes, withPrivateKey: privateKey)
      XCTAssertEqual(sharedSecretBytes, decaps.data)
    }
  }

  private func hexComponents(fromHex hex: String) throws -> [Data] {
    let converted = TUTEncodingConverter.hex(toBytes: hex)
    var offset = 0

    var d = [Data]()
    while offset < converted.count {
      // Make sure we can read a full size
      guard offset + 2 <= converted.count else {
        throw TutanotaError(message: "Badly formatted hex components string (size cutoff)")
      }

      // Get the nibble count - ensure it's even!
      let sizeBytes = Int(converted[offset]) << 8 | Int(converted[offset + 1]) // big endian

      offset += 2
      guard offset + sizeBytes <= converted.count else {
        throw TutanotaError(message: "Badly formatted hex components string (size cutoff)")
      }
      d.append(Data(converted[offset..<offset+sizeBytes]))
      offset += sizeBytes
    }

    return d
  }

  private func kyberParsePublicKey(hex: String) throws -> KyberPublicKey {
    // key is expected by oqs in the same order t, rho

    let components = try hexComponents(fromHex: hex)
    return KyberPublicKey(raw: DataWrapper(data:components[0] + components[1]))
  }

  private func kyberParsePrivateKey(hex: String) throws -> KyberPrivateKey {
    // key is expected by oqs in this order (vs how we encode it on the server): s, t, rho, hpk, nonce

    let components = try hexComponents(fromHex: hex)
    return KyberPrivateKey(raw: DataWrapper(data:components[0] + components[3] + components[4] + components[1] + components[2]))
  }

}
