import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from "n8n-workflow";
import { USER_AGENT } from "../lib/api";

/**
 * One API key from the ImageStep console (Account → API keys). Sent as `Authorization: ApiKey …`
 * on every request. The credential test reads the key's own usage, a path only a valid key can: it used to list the op
 * catalogue, which is public, so a wrong or revoked key tested green (#569). The test sends the package's User-Agent like
 * every other request the node makes (#722).
 */
export class ImageStepApi implements ICredentialType {
  name = "imageStepApi";

  displayName = "ImageStep API";

  documentationUrl = "https://imagestep.dev/docs/n8n?utm_source=n8n&utm_medium=credential";

  icon: Icon = "file:../nodes/ImageStep/imagestep.svg";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "An ImageStep API key (console → Account → API keys)"
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.imagestep.dev",
      description: "Change only for a self-hosted or staging ImageStep"
    }
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=ApiKey {{$credentials.apiKey}}"
      }
    }
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.baseUrl}}",
      url: "/api/v1/usage",
      headers: { "User-Agent": USER_AGENT }
    }
  };
}
